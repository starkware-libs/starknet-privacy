# Bug Hunter #7 — TokenBalances & Balance Tracking Findings

**Scope:** `packages/privacy/src/objects.cairo`, `packages/privacy/src/privacy.cairo`

---

## BUG-7-01 (HIGH): `add_balance` performs wrapping u128 addition — silent overflow possible

**File:** `packages/privacy/src/objects.cairo`, line 13

```cairo
self = entry.finalize(new_value: current_balance + amount);
```

**Analysis:**

In Cairo, `u128 + u128` wraps on overflow (it is equivalent to `wrapping_add`). There is no
checked/saturating variant used here. The `subtract_balance` function correctly uses
`CheckedSub`, but `add_balance` does not apply any overflow guard.

**Attack scenario — wrap-around balance fraud:**

Consider a transaction where an attacker uses multiple notes via `UseNote` (all different notes
are valid since nullifiers are written via `WriteOnce` and each is unique):

1. Attacker owns notes for token T summing to `u128::MAX + K` (where K is a small integer, e.g. 5).
2. Calling `use_note` for each adds to `token_balances[T]`.
3. After all `add_balance` calls, the balance wraps: `(u128::MAX + K) % 2^128 = K - 1` (example).
4. The final net balance after calling `subtract_balance` for a withdrawal of `K - 1` is zero.
5. `assert_valid` passes: all balances are zero.

**Net effect:** The attacker extracted `K - 1` tokens from the contract while only "paying" with
notes worth `K - 1` tokens after the wrap, but those notes originally represented `u128::MAX + K`
worth of tokens deposited by legitimate users. This is a theft-of-funds vulnerability.

**Precondition:** The attacker must own multiple valid notes whose combined deposited amounts
overflow u128. In practice, u128::MAX ≈ 3.4 × 10^38, so for standard ERC20 tokens with 18
decimals this would require ~3.4 × 10^20 tokens worth of notes — far beyond any realistic
token supply. **For tokens with very small decimals (e.g., 0 decimals) or custom tokens, this
could be reachable.**

The vulnerability is real but practically constrained by token economics. It should still be
fixed because:
- The contract is designed to be token-agnostic.
- A future token with different parameters could be affected.
- Defensive arithmetic is always preferable for financial logic.

**Fix:** Replace `current_balance + amount` with a checked add:

```cairo
fn add_balance(ref self: TokenBalances, token: ContractAddress, amount: u128) {
    let (entry, current_balance) = self.entry(key: token.into());
    let new_value = current_balance
        .checked_add(amount)
        .expect(errors::BALANCE_OVERFLOW);
    self = entry.finalize(:new_value);
}
```

This requires adding a new error constant `BALANCE_OVERFLOW`.

---

## BUG-7-02 (LOW/INFO): `add_balance` overflow blocks rather than enables exploitation for most overflow patterns

**Supplementary analysis to BUG-7-01:**

For the specific case where `current_balance = u128::MAX` and `amount = 1`, the result is `0`
(complete wraparound). Any subsequent `subtract_balance` call then immediately panics with
`NEGATIVE_INTERMEDIATE_BALANCE` (since `checked_sub(0, anything > 0)` returns None). So the
attacker gets stuck — they cannot withdraw anything because the balance is zero and subtraction
panics.

This means **only partial wraparound scenarios** (where the wrapped result is non-zero and
equals exactly what the attacker wants to withdraw) are exploitable. The exploitable window
is narrow, requiring precise control over the sum. As noted in BUG-7-01, this is practically
unreachable for standard tokens.

---

## FINDING-7-03 (CONFIRMED SAFE): Nullifier prevents double-spend of same note

**Analysis:**

The nullifier for a given note is computed as:
```
nullifier = h(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)
```

It is written via `WriteOnce`, which asserts the storage slot is zero before writing. If the
same `(channel_key, token, index, owner_private_key)` tuple is used twice within the same
transaction, the second `WriteOnce` for that nullifier panics because the slot was already
written in the first call's `_client_apply_actions`.

This correctly prevents a single note from being used twice to inflate the balance.

---

## FINDING-7-04 (CONFIRMED SAFE): `assert_valid` on `SquashedTokenBalances` — Felt252Dict semantics

**Analysis:**

The `squash()` method on `Felt252Dict<u128>` in Cairo returns a `SquashedFelt252Dict` that
iterates over all entries that were **actually accessed** (read or written) during the dict's
lifetime. Entries that were never touched do not appear, so they cannot fail the zero-balance
assertion. Default-zero (untouched) entries are safe.

There is no false positive from phantom zero entries here.

---

## FINDING-7-05 (CONFIRMED SAFE): Token address collision via `ContractAddress → felt252`

**Analysis:**

`ContractAddress` in Cairo is a newtype wrapper around `felt252`. The `into()` conversion is
a no-op cast — it returns the underlying felt252 directly. Two distinct `ContractAddress` values
therefore always produce distinct felt252 keys. No collision is possible.

---

## FINDING-7-06 (CONFIRMED SAFE): `enc_note_packed_value` cannot be zero

**Analysis:**

```
packed_value = pack(salt, enc_amount)
             = u256 { high: salt, low: enc_amount }.try_into()
```

`salt` must satisfy `salt > OPEN_NOTE_SALT (=1)` and `salt < TWO_POW_120`, enforced in
`CreateEncNoteInputValid::assert_valid`. Since `salt >= 2`, the high 128 bits of the u256 are
non-zero, making the felt252 value non-zero regardless of `enc_amount`. The check
`assert(packed_value.is_non_zero(), ...)` is therefore always redundant but harmless.

---

## FINDING-7-07 (INFO): `decode_note_amount` can return zero for encrypted notes — `use_note` correctly guards this

**Analysis:**

For encrypted notes, `decode_note_amount` decrypts the amount via:
```
amount = (enc_amount - h(...)) % 2^128
```

If the decrypted amount happens to be zero (i.e. the note was created with `amount = 0`,
which `CreateEncNoteInput::assert_valid` explicitly allows for revert-index-protection), then
`use_note` catches this with:
```cairo
assert(amount.is_non_zero(), errors::ZERO_NOTE_AMOUNT_USAGE);
```

This correctly rejects zero-value note usage. No bypass is possible.

---

## Summary Table

| ID | Severity | Status | Description |
|----|----------|--------|-------------|
| BUG-7-01 | HIGH | **BUG** | `add_balance` uses wrapping u128 addition — overflow silently wraps balance, enabling theft for non-standard tokens |
| BUG-7-02 | LOW | INFO | Complete wraparound (result = 0) self-defeats — only partial wraps are exploitable |
| FINDING-7-03 | N/A | SAFE | Nullifier `WriteOnce` prevents same-note double-spend within a transaction |
| FINDING-7-04 | N/A | SAFE | `SquashedFelt252Dict` only iterates touched entries — no false positives in `assert_valid` |
| FINDING-7-05 | N/A | SAFE | `ContractAddress` is a felt252 newtype — no key collision possible |
| FINDING-7-06 | N/A | SAFE | `enc_note_packed_value` is always non-zero when `salt >= 2` |
| FINDING-7-07 | N/A | SAFE | Zero-amount encrypted notes are guarded by `ZERO_NOTE_AMOUNT_USAGE` in `use_note` |

---

## Recommended Fix for BUG-7-01

In `packages/privacy/src/objects.cairo`:

```cairo
use core::num::traits::{CheckedAdd, CheckedSub, Zero};
// (add CheckedAdd to the existing import)

fn add_balance(ref self: TokenBalances, token: ContractAddress, amount: u128) {
    let (entry, current_balance) = self.entry(key: token.into());
    let new_value = current_balance
        .checked_add(amount)
        .expect(errors::BALANCE_OVERFLOW);
    self = entry.finalize(new_value: new_value);
}
```

And add to `packages/privacy/src/errors.cairo`:

```cairo
pub const BALANCE_OVERFLOW: felt252 = 'BALANCE_OVERFLOW';
```
