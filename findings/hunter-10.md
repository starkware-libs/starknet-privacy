# Bug Hunter #10 — Domain Separation Findings

**Target:** `packages/privacy/src/hashes.cairo`
**Date:** 2026-06-13

---

## Summary

All domain-separation tags are distinct ASCII short-strings encoded as `felt252`. All hash functions carry unique tags as their first element, and no two functions share the same tag. The primary findings concern structural ambiguity and a missing input validation, not full collisions.

---

## Finding 1 — NOTE_ID_TAG is a Structural Prefix of NULLIFIER_TAG (Informational)

### Layouts

```
note_id   = h(NOTE_ID_TAG,   channel_key, token, index, 0)           -- 5 elements
nullifier = h(NULLIFIER_TAG, channel_key, token, index, 0, owner_pk) -- 6 elements
```

The comment in the code reads: *"Includes a reserved zero placeholder to match the note_id hash layout."* This is intentional — the zero at position 4 was placed in `nullifier` so the two hashes share the same prefix structure up to position 4. The tags (`NOTE_ID_TAG` = `'NOTE_ID_TAG:V1'`, `NULLIFIER_TAG` = `'NULLIFIER_TAG:V1'`) are distinct, so there is no collision. However, the explicit structural coupling deserves scrutiny:

**Observation:** The `nullifier` is computed over `(TAG, channel_key, token, index, 0, owner_private_key)`. The zero at index 4 was deliberately placed to mimic `note_id`'s layout. If a future maintainer extends `note_id` to 6 elements by filling in the zero placeholder (per the "forward compatibility" comment), the structures will be fully length-matched, and the only thing preventing collision is the different first-element tag. This is sound cryptographically, but the layered coupling between the two hash layouts increases maintenance risk. The "forward compatibility" placeholder zero in `note_id` and the matching zero in `nullifier` are co-dependent implicit conventions with no test asserting `note_id != nullifier` for the same inputs (only that varying each function's inputs changes its own output).

**Recommendation (Low / Informational):** Add a cross-function test asserting `compute_note_id(ck, token, idx) != compute_nullifier(ck, token, idx, any_key)` for at least one fixed input set. This makes the domain-separation invariant between the two functions explicit and serves as a regression guard.

---

## Finding 2 — `channel_key` Not Validated as Non-Zero in `UseNoteInput` and `OpenSubchannelInput` (Low)

### Location

`packages/privacy/src/actions.cairo`, lines 175–179 (`UseNoteInputValid`) and lines 68–78 (`OpenSubchannelInputValid`).

### Detail

`UseNoteInput.channel_key` and `OpenSubchannelInput.channel_key` are both passed directly into hash computations (`compute_note_id`, `compute_nullifier`, `compute_subchannel_id`, `compute_subchannel_marker`) without being asserted non-zero in `assert_valid`.

```cairo
// UseNoteInputValid — channel_key is silently allowed to be zero
pub(crate) impl UseNoteInputValid of InputValidation<UseNoteInput> {
    fn assert_valid(self: UseNoteInput) {
        let UseNoteInput { channel_key: _, token, index: _ } = self;
        assert(token.is_non_zero(), errors::ZERO_TOKEN);
    }
}

// OpenSubchannelInputValid — channel_key is silently allowed to be zero
pub(crate) impl OpenSubchannelInputValid of InputValidation<OpenSubchannelInput> {
    fn assert_valid(self: OpenSubchannelInput) {
        let OpenSubchannelInput {
            recipient_addr, recipient_public_key, channel_key: _, index: _, token, salt,
        } = self;
        ...
    }
}
```

A zero `channel_key` will produce a deterministic but degenerate hash. While the protocol's downstream checks (e.g., `subchannel_exists` map lookup) would reject zero-channel-key operations in practice because no such subchannel/note will ever have been created with a zero channel_key, a zero channel_key passed into `compute_nullifier` with `index=0` and a known `token` would produce a specific nullifier that is predictable before the note exists. There is no note to spend, so this cannot cause theft; however, an adversary could pre-register a nullifier for `channel_key=0` if the contract ever accepted it (it would be rejected by `NOTE_NOT_FOUND` first).

The hash functions themselves carry doc comments saying "Assumes all the inputs are not zero" or "Assumes `token` is not zero" — the zero-channel-key case is explicitly flagged as a precondition violation at the hash layer but never enforced at the action-validation layer.

**Severity:** Low. No direct exploitability was identified, but a defense-in-depth assertion is missing at the input validation boundary.

**Recommendation:** Add `assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY);` (or an equivalent error constant) in both `UseNoteInputValid` and `OpenSubchannelInputValid`.

---

## Finding 3 — `compute_outgoing_channel_id` vs `compute_channel_key` Structural Overlap (Informational)

### Layouts

```
channel_key          = h(CHANNEL_KEY_TAG,          sender_addr, sender_pk, recipient_addr, recipient_pk) -- 5 elements
outgoing_channel_id  = h(OUTGOING_CHANNEL_ID_TAG,  sender_addr, sender_pk, index, 0)                    -- 5 elements
```

Both are 5-element hashes. The first three inputs (`CHANNEL_KEY_TAG`/`OUTGOING_CHANNEL_ID_TAG`, `sender_addr`, `sender_pk`) share the same positional semantics. Positions 4–5 differ in type (address + pubkey vs. index + zero). The distinct tags prevent collisions. However, if `recipient_addr` were the integer value of an `index` (i.e., a very small number), these two functions would differ only in tag and in positions 4 and 5. This is an extremely unlikely coincidence given address derivation, and the tags provide full separation.

**Verdict:** No vulnerability. Noted for completeness.

---

## Finding 4 — `compute_enc_token_hash` vs `compute_note_id` Length Match with Zero Padding (Informational)

### Layouts

```
enc_token = h(ENC_TOKEN_TAG, channel_key, index, 0,     salt)  -- 5 elements
note_id   = h(NOTE_ID_TAG,   channel_key, token, index, 0)     -- 5 elements
```

Both are 5-element hashes. Positional alignment differs (position 2 is `index` vs. `token`, position 3 is `0` vs. `index`, position 4 is `salt` vs. `0`). Tags are distinct. No collision is possible by tag separation alone. Noted only because the zero-padding positions differ, making the two hashes more structurally distinct than they might appear by length alone.

**Verdict:** No vulnerability.

---

## Finding 5 — No Cross-Function Domain-Separation Test Suite Exists (Informational)

The existing tests in `test_hashes.cairo` test that each hash function is sensitive to each of its own inputs. However, there is no test asserting that two *different* hash functions with identical non-tag inputs produce distinct outputs. For the pairs that share the same arity (5 or 6 elements), this would be a trivial but valuable regression guard.

Functions with the same arity that should be tested for cross-function non-collision:
- `compute_channel_key` vs. `compute_channel_marker` (both 5-element, different tag + semantics)
- `compute_note_id` vs. `compute_nullifier` (5 vs. 6 elements, already distinguished by length, but a test documents the intent)
- `compute_enc_amount_hash` vs. `compute_nullifier` (both 6-element — same positions 1–4, different position 5: `salt` vs. `owner_private_key`, different tags)

**Recommendation (Informational):** Add cross-function non-collision tests for same-arity pairs to make the domain separation contract explicit and machine-checked.

---

## Finding 6 — `compute_enc_amount_hash` vs `compute_nullifier` Same-Arity Structural Match (Low / Informational)

### Layouts

```
enc_amount = h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt)              -- 6 elements
nullifier  = h(NULLIFIER_TAG,  channel_key, token, index, 0, owner_private_key) -- 6 elements
```

These two are **structurally identical** except for the tag (position 0) and the final element (`salt: u128` vs. `owner_private_key: felt252`). Both have the same 6-element layout and identical positions 1–4.

Key observation: `salt` is typed as `u128` in `compute_enc_amount_hash`, while `owner_private_key` is `felt252`. The `u128` is cast to `felt252` via `.into()`. Any `u128` value fits in the lower 128 bits of a `felt252`, so the overlap domain is all 128-bit values. If a `salt` value were chosen equal to an `owner_private_key` value (only possible if `owner_private_key < 2^128`), then the two outputs would still differ because the tags differ. The tag separation fully prevents a collision.

**However**, the structural identity of these two hashes means that an `enc_amount` ciphertext and a `nullifier` are indistinguishable in format. Since both are stored on-chain, a block observer cannot tell the two apart by structure alone. This is a privacy property observation: `enc_amount` is emitted in events, `nullifier` is stored in a map. The lack of structural distinction is not a vulnerability, but it reduces the ability to do anomaly detection / chain analysis separation.

**Verdict:** No cryptographic vulnerability. The same-arity, same-structure relationship is worth documenting and potentially adding a cross-function test for.

---

## Summary Table

| Finding | Severity | Type |
|---|---|---|
| 1. `note_id`/`nullifier` structural coupling, no cross-function test | Informational | Missing test |
| 2. `channel_key` not validated non-zero in `UseNoteInput` and `OpenSubchannelInput` | Low | Missing input validation |
| 3. `channel_key` vs. `outgoing_channel_id` structural overlap | Informational | Notes only |
| 4. `enc_token` vs. `note_id` length match | Informational | Notes only |
| 5. No cross-function domain-separation test suite | Informational | Missing test |
| 6. `enc_amount_hash` vs. `nullifier` structurally identical (except tag and last element) | Low / Informational | Missing test, privacy observation |

---

## Verdict on Critical Checks

All domain separation tags are distinct strings. No two hash functions share the same tag. All functions using Poseidon's `poseidon_hash_span` with a tag as the first element are protected against inter-function collision by the hash function's preimage resistance.

No hash collision vulnerability was found. The only actionable items are:
1. A missing non-zero assertion on `channel_key` in action input validation (Finding 2).
2. Missing cross-function non-collision regression tests (Findings 1, 5, 6).
