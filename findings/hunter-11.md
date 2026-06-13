# Bug Hunter #11 — Findings

**Target:** `packages/privacy/src/utils.cairo` — `pack`/`unpack` and note amount encryption/decryption  
**Date:** 2026-06-13

---

## Summary

Six candidate bug areas were investigated. Three are confirmed safe (no bug), two require nuanced assessment (low-risk with caveats), and one is a genuine finding worth flagging.

---

## Finding 1: `unpack` panic on externally written `packed_value`

**Verdict: Safe, with one subtle caveat.**

All writes to `notes` storage go through exactly two code paths:

1. `_apply_write_once` (called during `compile_actions` → server execution). The `packed_value` written there originates from either `enc_note_packed_value` (for `CreateEncNote`) or `open_note` (for `CreateOpenNote`). Both guarantee `salt < TWO_POW_120`.

2. `_deposit_to_open_note` (called from `_apply_invoke`). This path writes `pack(value_1: OPEN_NOTE_SALT, value_2: amount)` where `OPEN_NOTE_SALT = 1 < TWO_POW_120`. Safe.

There is no direct storage write that could introduce a `packed_value` with high bits ≥ `TWO_POW_120`. The `_apply_write_once` function writes raw `felt252` values, but those values are always produced by the internal helper functions above, never by external input alone.

**Caveat:** `_apply_write_once` takes a `WriteOnceInput { storage_address, value: Span<felt252> }` and writes raw felts to storage. The `storage_address` could theoretically be crafted to alias the notes map. However, the `storage_address` is derived inside `_prepare_note_creation` via `storage_path_to_felt252(path: self.notes.entry(note_id))` — a deterministic Pedersen-based address — and the packed_value is computed by trusted internal code, not from external input. An attacker cannot submit a raw `ServerAction::WriteOnce` directly; server actions are only applied after being produced by `compile_and_panic`, which gates them via the proof verification (`validate_proof`). So no external path to write a malformed `packed_value` exists.

---

## Finding 2: `_encrypt_note_amount` — correctness and degenerate case

**Verdict: Correct by design. The hash.low == 0 case is not exploitable but worth documenting.**

The encryption mask is `enc_amount_hash.low`, where `enc_amount_hash` is a Poseidon hash over `(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt)` converted to `u256` and taking the lower 128 bits.

Since Poseidon hash output is a `felt252` value in `[0, P)` where `P ≈ 2^251 + 17·2^192 + 1`, the high 128 bits of the `u256` representation are always 0 or 1 (since `P < 2^252`). Specifically, `hash.high ≤ 7` (since `P < 8 · 2^248`). The encryption only uses `hash.low`.

**Degenerate case `hash.low == 0`:** When this occurs, `enc_amount = amount` — the encrypted amount leaks the plaintext amount to anyone who can observe the `packed_value`. This is negligible in practice (probability ≈ 1/2^128), but it is worth noting that the encryption has no protection against this case. A motivated adversary who can choose `salt` values cannot force this case since `salt` must satisfy `salt > OPEN_NOTE_SALT` and `salt < TWO_POW_120`, but the sender chooses `salt` — a malicious sender (not the threat model here) could bruteforce.

**Correctness of `wrapping_add`/`wrapping_sub`:** The pair is a correct mod-2^128 one-time pad. Encryption: `enc = (mask + amount) mod 2^128`. Decryption: `amount = (enc - mask) mod 2^128`. These are inverses over `u128` arithmetic. No bug.

---

## Finding 3: `OPEN_NOTE_PACKED_VALUE` constant and felt252 range

**Verdict: Safe.**

`OPEN_NOTE_PACKED_VALUE = u256 { high: 1, low: 0 }.try_into().unwrap()` computes to `2^128`.

The felt252 prime is `P = 2^251 + 17·2^192 + 1`. Since `2^128 < P`, this value fits in a felt252 with no truncation. The `try_into()` succeeds.

The `unwrap()` on a `const` expression is evaluated at compile time by the Cairo compiler and would cause a compile-time panic if it could fail, so this is a non-issue.

---

## Finding 4: `decode_note_amount` for open note — amount=0 semantics

**Verdict: Correct by design. No bug.**

For an undeposited open note, `packed_value = OPEN_NOTE_PACKED_VALUE = pack(1, 0)`. `unpack` returns `(salt=1, amount=0)`. Since `salt == OPEN_NOTE_SALT`, `decode_note_amount` returns `0` directly.

This zero is caught by `assert(amount.is_non_zero(), errors::ZERO_NOTE_AMOUNT_USAGE)` in `use_note`, which correctly prevents using an undeposited open note.

After deposit, `_deposit_to_open_note` writes `pack(OPEN_NOTE_SALT, deposit_amount)` where `deposit_amount` is asserted non-zero (`assert(amount.is_non_zero(), errors::ZERO_AMOUNT)`). The flow is correct.

**One subtle point:** `assert(packed_value.is_non_zero(), errors::NOTE_NOT_FOUND)` in `use_note` is checked before `decode_note_amount`. `OPEN_NOTE_PACKED_VALUE = 2^128 ≠ 0`, so this check correctly passes for existing open notes.

---

## Finding 5: `pack` overflow — potential panic with large `value_1`

**Verdict: No reachable overflow in practice, but there is a theoretical concern with the assertion comment.**

`pack` calls `u256 { high: value_1, low: value_2 }.try_into().expect(PACK_OVERFLOW)`. A `u256` value fits in a `felt252` iff it is less than `P = 2^251 + 17·2^192 + 1`.

For the maximum valid inputs (`value_1 = TWO_POW_120 - 1`, `value_2 = 2^128 - 1`):

```
packed = (2^120 - 1) * 2^128 + (2^128 - 1) = 2^248 - 1
```

Since `2^248 - 1 < P`, this fits. No overflow.

**What if `value_1 >= TWO_POW_120`?** The maximum representable u128 is `2^128 - 1`, so the maximum packed value would be `(2^128 - 1) * 2^128 + (2^128 - 1) = 2^256 - 1`, which far exceeds P. The `try_into()` would panic. However, all callers of `pack` enforce `value_1 < TWO_POW_120` before calling, so this is unreachable.

**Gap:** The function's doc comment says "Assumes: value_1 is 120 bits, value_2 is 128 bits" but there is no runtime assertion enforcing this precondition. The function relies entirely on caller discipline. If a future caller violates this (e.g., passing a full 128-bit salt), the function would panic at runtime via `expect(PACK_OVERFLOW)`. This is a defense-in-depth gap: the assumption is documented but not enforced.

**Recommendation:** Add an assertion `assert(value_1 < TWO_POW_120, internal_errors::PACK_OVERFLOW)` at the top of `pack`, before the `try_into`. This would give a clearer error message and prevent silent behavioral drift from future callers.

---

## Finding 6 (REAL BUG): Biased encryption mask from `enc_amount_hash.high`

**Verdict: Confirmed low-severity cryptographic weakness — the `.high` bits of the Poseidon-to-u256 cast are almost always zero, creating a non-uniform distribution of the mask. More importantly, using only `.low` means the 128-bit mask is drawn from a distribution with slight bias.**

### Technical Detail

`compute_enc_amount_hash` returns a `felt252` in `[0, P)` where `P = 2^251 + 17·2^192 + 1`.

When cast to `u256`, the value occupies `[0, P)` within `[0, 2^256)`. The `.low` field extracts bits `[0, 127]` of this `u256`.

The key issue: `P` is not a multiple of `2^128`. The number of `felt252` values whose low 128 bits equal a specific value `v` is:

- `ceil(P / 2^128)` or `floor(P / 2^128)` depending on `v`.

Since `P mod 2^128 = 17·2^64 + 1` (approximately), the bias is on the order of `2^-128 * (P mod 2^128) / P ≈ 17·2^64 / 2^251 ≈ 1/2^187`. This is cryptographically negligible (well below 2^-128 security).

### However, there is a more significant observation:

The cast `felt252 → u256` produces a value in `[0, P)`. The `.low` 128 bits are in `[0, 2^128)` (as expected). But the `.high` 128 bits are **always in `[0, 7]`** (since `P < 8 · 2^248`). This means:

1. The `.low` field is used as the full 128-bit mask — this is correct and standard.
2. The `.high` field (bits 128–255) is wasted but this is intentional.

**No cryptographic bug.** The bias from `P mod 2^128` is negligible. The design is standard practice.

### Actual concern: enc_amount_hash.high is silently discarded

The code:
```cairo
let enc_amount_hash: u256 = compute_enc_amount_hash(...).into();
enc_amount_hash.low.wrapping_add(amount)
```

discards `enc_amount_hash.high`. Given that `P < 2^252`, `enc_amount_hash.high` is always `< 16`. Using only `.low` for the 128-bit mask is fine, but the discarded upper bits could have been incorporated into the mask for marginally stronger output (e.g., XOR or Poseidon of both halves). This is a missed hardening opportunity, not a bug.

**Verdict: No exploitable bug. The encryption is cryptographically sound given Poseidon's pseudorandomness.**

---

## Finding 7 (REAL BUG): `_apply_write_once` — first felt must be non-zero, but `Note.packed_value` could write token as second slot

**Verdict: Potential storage aliasing / partial-write concern — requires verification.**

`_apply_write_once` reads and writes sequential storage slots starting at `storage_address`. The assertion `assert(value[0].is_non_zero(), ...)` only checks the first felt. For `create_open_note`, the code writes `note: Note` (a struct with two fields: `packed_value: felt252` and `token: ContractAddress`) via `to_write_once_action(:storage_address, value: note)`.

However, looking more carefully at `create_open_note`:

```cairo
// Only `packed_value` needs to be written to storage, `token` is initialized to zero.
array![
    to_write_once_action(:storage_address, value: packed_value),
    ...
]
```

Wait — for `create_enc_note`, it writes only `packed_value` (a single `felt252`) using `to_write_once_action(:storage_address, value: packed_value)`.

For `create_open_note`, it writes `to_write_once_action(:storage_address, value: note)` where `note: Note { packed_value: OPEN_NOTE_PACKED_VALUE, token }`.

The `Note` struct's `Serde` implementation serializes `packed_value` first, then `token`. So the write occupies two consecutive storage slots: slot 0 = `packed_value`, slot 1 = `token`.

The comment in `create_enc_note` says "Only `packed_value` needs to be written to storage, `token` is initialized to zero" — meaning for encrypted notes, the `token` slot is left as zero, and for open notes, the `token` slot is written with the actual token address.

This is consistent and intentional. The `Note.token` for encrypted notes is read back as zero (its default storage value), which is acceptable because encrypted note decryption doesn't use the token from storage (it uses the token passed to `use_note`).

**Wait — that creates an issue:** When reading an encrypted note via `use_note`, the code reads `packed_value = self.notes.entry(note_id).packed_value.read()` — only the packed_value slot. The token is passed in from the `UseNoteInput` struct (not read from storage). So the encrypted note's `token` field in storage is never written and stays zero. This is fine because `use_note` takes `token` as an explicit input and verifies ownership via `subchannel_marker` which includes the token.

**No bug here.** The design is intentional.

---

## Finding 8 (REAL BUG CANDIDATE): `_deposit_to_open_note` — direct storage write bypasses `_apply_write_once` write-once guarantee

**Verdict: Confirmed design concern — the `packed_value` of an open note is mutable after initial creation.**

The `_apply_write_once` mechanism provides an append-only guarantee: a storage slot can be written exactly once (from zero to non-zero). This is used for all note creation.

However, `_deposit_to_open_note` does:

```cairo
note_entry.packed_value.write(new_packed_value);
```

This is a **direct mutable write** via the `StoragePointerWriteAccess` trait, bypassing `_apply_write_once`. The code explicitly checks `assert(current_amount.is_zero(), errors::NOTE_ALREADY_DEPOSITED)` to prevent double-deposits, which is the intended guard.

**Is this a bug?** The write-once property is intentionally relaxed for open notes: they start at `(OPEN_NOTE_SALT, 0)` and are updated to `(OPEN_NOTE_SALT, amount)` exactly once. The `NOTE_ALREADY_DEPOSITED` check enforces "write-once-after-initial". This is by design.

However, this creates an asymmetry: encrypted notes are truly immutable once written (their `packed_value` can never change), while open notes have a two-phase lifecycle (creation then deposit). This is intentional but increases the attack surface around the `_deposit_to_open_note` path. The `blocked_depositors` mechanism addresses depositor trust.

**Not a bug — design intent is clear and protected.**

---

## Finding 9 (REAL BUG): Missing test coverage for `hash.low == 0` degenerate encryption case

**Verdict: Test gap, not a code bug.**

The test `test_encrypt_decrypt_note_amount` tests amounts `[1, 123456789, MAX_U128]` but does not test what happens when `hash.low == 0` (enc_amount == amount, trivially). While this is cryptographically negligible, a test with a mock hash returning zero would confirm the wrapping arithmetic still correctly round-trips. This is a test quality concern, not a security bug.

---

## Consolidated Verdict

| # | Area | Verdict |
|---|------|---------|
| 1 | `unpack` panic on external values | Safe — all writes gated by trusted code |
| 2 | `_encrypt_note_amount` wrapping correctness | Correct — `wrapping_add`/`wrapping_sub` are proper inverses |
| 3 | `OPEN_NOTE_PACKED_VALUE` felt252 range | Safe — `2^128 << P` |
| 4 | `decode_note_amount` for open note | Correct by design |
| 5 | `pack` overflow / missing assertion | **Hardening gap** — precondition documented but not enforced; add runtime assert |
| 6 | `enc_amount_hash.high` bias | Cryptographically negligible bias; not exploitable |
| 7 | `Note.token` slot handling | Safe — intentional design |
| 8 | Open note direct write bypasses WriteOnce | Intentional design with correct guards |
| 9 | Missing degenerate test coverage | Test quality gap |

### Primary Recommendation

**Finding 5** is the only actionable code change: add `assert(value_1 < TWO_POW_120, internal_errors::PACK_OVERFLOW)` at the start of `pack`. Currently the function's safety is entirely caller-discipline; the `try_into().expect(PACK_OVERFLOW)` fires only after the u256 is constructed, and the error message misleadingly suggests an overflow when the root cause is an invalid input. A pre-condition assertion provides clearer intent and catches future misuse earlier.

No critical security vulnerabilities were found in the `pack`/`unpack` or note encryption/decryption logic.
