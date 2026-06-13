# Supervisor 3 — Verdict Report for Hunters 9–12

**Date:** 2026-06-13  
**Scope:** Validation of all findings from Bug Hunters 9, 10, 11, and 12.  
**Method:** Each claim was independently verified by reading the cited source files directly, then cross-checking the hunter's reasoning against the actual code.

---

## H9 — Hunter 9 (ECDH correctness, utils.cairo)

### H9-F1: y-Coordinate Ambiguity in ECDH

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Hunter 9 itself concluded this is not a bug and closed the investigation. Verified independently: `_compute_shared_x` at `utils.cairo:100–113` uses scalar multiplication and takes only the x-coordinate of the result. Because negating an elliptic curve point flips only the y-coordinate while leaving x unchanged, `r*(±P) = ±(r*P)` both yield the same x-coordinate. The x-only shared secret is identical regardless of which y `new_from_x` selects. This is mathematically sound.

### H9-F2: Cross-Layer y-Coordinate Convention Mismatch (Documentation Gap)

**Verdict: CONFIRMED**  
**Severity: INFO**

Verified: Cairo `EcPointTrait::new_from_x` picks one y by an internal convention that is never documented at the call site in `utils.cairo:108`. The Rust decryption (`AffinePoint::new_from_x(&x, false)`) explicitly picks the even-y point via a `false` sign parameter. Neither call site explains why the y-choice does not affect the shared secret (the x-only ECDH invariant). The hunter's concern is real: a future implementor encountering these inconsistent conventions without explanation could introduce a real bug trying to "fix" the apparent discrepancy. The missing comment is a genuine maintenance risk. No code correctness issue exists today.

### H9-F3: ephemeral_secret Equal to Curve Order Causes Panic (Self-DoS)

**Verdict: CONFIRMED**  
**Severity: LOW**

Verified directly against the code and verified mathematically. The Stark curve group order n = `0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f`. Since `0 < n < P` (where P is the Stark field prime), n is a valid non-zero `felt252` value. The check `assert(random.is_non_zero(), errors::ZERO_RANDOM)` in each `assert_valid` implementation (confirmed in `actions.cairo:21,43,143,201`) passes when `random = n`. However, `GEN_P().mul(scalar: n)` computes `n*G` which equals the identity point (point at infinity) because n is the group order. The subsequent `.try_into().expect(internal_errors::ZERO_EPHEMERAL_PUBLIC)` at `utils.cairo:103–105` will panic. The attack is strictly self-inflicted: only the submitting user's transaction reverts. No other user is affected and no state is corrupted. The finding is accurate.

### H9-F4: derive_public_key Uniqueness for Canonical Keys

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Hunter 9 correctly closed this. The `is_canonical_key` function (`utils.cairo:237–239`) enforces `key < ORDER/2`, confirmed with `HALF_ORDER = ORDER / 2` in `utils.cairo:67`. For any canonical k, the only other key sharing the same public key x-coordinate is `n-k > n/2`, which fails canonicality. No two canonical keys share the same x-coordinate. The invariant holds.

### H9-F5: Same shared_x for Two Fields with Distinct Tags

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Verified: `encrypt_channel_info` (`utils.cairo:154–167`) uses `compute_enc_channel_key_hash(shared_x)` and `compute_enc_sender_addr_hash(shared_x)` — confirmed in `hashes.cairo:71–79` to use distinct tags `ENC_CHANNEL_KEY_TAG:V1` and `ENC_SENDER_ADDR_TAG:V1`. No collision is possible under Poseidon preimage resistance. Correctly not a bug.

### H9-F6: channel_key = 0 if Poseidon Outputs Zero

**Verdict: SUSPECTED**  
**Severity: INFO**

Verified: `compute_channel_key` in `hashes.cairo:102–115` returns a raw Poseidon hash with no zero-check. The doc comment for `encrypt_subchannel_info` (`utils.cairo:76`) says "Assumes all the inputs (except index) are not zero" but no enforcement exists. The probability of any specific Poseidon output being zero is ~1/P ≈ 2^−252 — cryptographically negligible. The hunter's classification as "Theoretical / Negligible" is accurate. There is no practical exploitability, but a defensive `assert` would be appropriate for belt-and-suspenders code quality. Elevated to SUSPECTED rather than CONFIRMED only because the probability is beyond negligible and no realistic scenario exists.

---

## H10 — Hunter 10 (Domain separation, hashes.cairo)

### H10-F1: NOTE_ID_TAG is a Structural Prefix of NULLIFIER_TAG

**Verdict: CONFIRMED**  
**Severity: INFO**

Verified: `compute_note_id` (`hashes.cairo:189–193`) produces `h(NOTE_ID_TAG, channel_key, token, index, 0)` and `compute_nullifier` (`hashes.cairo:212–218`) produces `h(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)`. The shared prefix structure (positions 1–4 identical, same zero placeholder at position 4) is explicitly documented with "Includes a reserved zero placeholder to match the note_id hash layout." The hunter's concern is real: the layouts are co-dependent by design, and no test asserts `note_id != nullifier` for the same inputs. The tags are distinct so there is no collision, but the coupling is a maintenance risk. Informational finding, accurately reported.

### H10-F2: channel_key Not Validated Non-Zero in UseNoteInput and OpenSubchannelInput

**Verdict: CONFIRMED**  
**Severity: LOW**

Verified directly from `actions.cairo`. `UseNoteInputValid::assert_valid` (`actions.cairo:175–179`) explicitly ignores `channel_key` via `channel_key: _` in its destructuring and only asserts `token.is_non_zero()`. `OpenSubchannelInputValid::assert_valid` (`actions.cairo:68–77`) also has `channel_key: _` in its destructuring. Both `compute_note_id`, `compute_nullifier`, `compute_subchannel_id`, and `compute_subchannel_marker` document that inputs should be non-zero, but there is no enforcement at the input-validation boundary. This is a defense-in-depth gap, consistently reported by Hunters 2, 5, and 10. The downstream rejection (`INVALID_CHANNEL` or `SUBCHANNEL_NOT_FOUND`) would catch real abuse in practice, but the validation boundary is incomplete. Finding is accurate.

### H10-F3: compute_outgoing_channel_id vs compute_channel_key Structural Overlap

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Verified: The functions have distinct first-element tags (`OUTGOING_CHANNEL_ID_TAG:V1` vs `CHANNEL_KEY_TAG:V1`). Despite positional similarity in arguments 1–2 (`sender_addr`, `sender_private_key`), the different tags fully prevent collision. Hunter 10 correctly judged this informational only, and even that is generous — it is a non-issue.

### H10-F4: compute_enc_token_hash vs compute_note_id Length Match

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Verified: Distinct tags (`ENC_TOKEN_TAG:V1` vs `NOTE_ID_TAG:V1`), and the positional alignment of arguments differs substantially (position 2 is `index` vs `token`, etc.). No collision risk. Hunter 10 correctly assessed this as informational only.

### H10-F5: No Cross-Function Domain-Separation Test Suite

**Verdict: CONFIRMED**  
**Severity: INFO**

Verified by inspection of `hashes.cairo`: all domain tags are distinct (14 unique string constants confirmed). However, the existing tests in `test_hashes.cairo` only verify that each function is sensitive to its own inputs, not that two different functions with the same non-tag inputs produce different outputs. For the same-arity pairs (e.g., `compute_enc_amount_hash` and `compute_nullifier` both 6-element), cross-function non-collision tests are absent. This is a test quality gap, not a cryptographic vulnerability.

### H10-F6: compute_enc_amount_hash vs compute_nullifier Structurally Identical

**Verdict: CONFIRMED**  
**Severity: INFO**

Verified: `compute_enc_amount_hash` (`hashes.cairo:199–205`) computes `h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt)` and `compute_nullifier` (`hashes.cairo:212–218`) computes `h(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)`. Both are 6-element hashes with positions 1–4 identical. The only distinctions are the tag (position 0) and the final element type (`u128` vs `felt252`). The tag separation is cryptographically sufficient. Hunter 10's privacy observation (these are structurally indistinguishable on-chain) is accurate but carries no exploitability.

---

## H11 — Hunter 11 (pack/unpack and note amount encryption, utils.cairo)

### H11-F1: unpack Panic on Externally Written packed_value

**Verdict: CONFIRMED (Not a Bug — accurate analysis)**  
**Severity: —**

Verified: All writes to `notes` storage go through trusted internal paths (either `enc_note_packed_value` which enforces `salt < TWO_POW_120`, or `_deposit_to_open_note` which writes `pack(OPEN_NOTE_SALT=1, amount)`). The storage address is derived from `_prepare_note_creation` via a Pedersen-based deterministic path, not from external input. No external path to write a malformed `packed_value` exists without going through `compile_and_panic`. Hunter 11's analysis is correct: no bug.

### H11-F2: _encrypt_note_amount Correctness and hash.low == 0 Case

**Verdict: CONFIRMED (Not a Bug — degenerate case correctly characterized)**  
**Severity: INFO**

Verified: `_encrypt_note_amount` (`utils.cairo:249–253`) computes `enc_amount_hash.low.wrapping_add(amount)`. When `hash.low == 0`, `enc_amount = amount` (trivial pad, leaking plaintext). Probability ≈ 1/2^128 — negligible. The `wrapping_add`/`wrapping_sub` pair is a correct mod-2^128 one-time pad. Hunter 11's characterization is accurate.

### H11-F3: OPEN_NOTE_PACKED_VALUE Constant Range

**Verdict: CONFIRMED (Not a Bug)**  
**Severity: —**

Verified: `OPEN_NOTE_PACKED_VALUE = u256 { high: 1, low: 0 }.try_into().unwrap()` = 2^128. Since `2^128 < P` (Stark field prime ≈ 2^251), this fits in a `felt252` with no truncation. Correct.

### H11-F4: decode_note_amount for Open Note, amount=0 Semantics

**Verdict: CONFIRMED (Not a Bug)**  
**Severity: —**

Verified: The flow for an undeposited open note produces `packed_value = OPEN_NOTE_PACKED_VALUE = pack(1, 0)`, `unpack` returns `(salt=1, amount=0)`. Since `salt == OPEN_NOTE_SALT`, `decode_note_amount` returns 0 directly. `use_note` (`privacy.cairo:561`) then asserts `amount.is_non_zero()` with `ZERO_NOTE_AMOUNT_USAGE`, correctly preventing use of undeposited open notes. Design is correct.

### H11-F5: pack Overflow — Missing Runtime Assertion

**Verdict: CONFIRMED**  
**Severity: LOW**

Verified directly from `utils.cairo:306–309`:
```cairo
pub(crate) fn pack(value_1: u128, value_2: u128) -> felt252 {
    let packed = u256 { high: value_1, low: value_2 };
    packed.try_into().expect(internal_errors::PACK_OVERFLOW)
}
```
There is no pre-condition assertion `assert(value_1 < TWO_POW_120)` before constructing the `u256`. The `expect(PACK_OVERFLOW)` fires only after the `u256` is constructed and `try_into()` fails — at that point the error message is misleading (it says `PACK_OVERFLOW` but gives no indication whether the input was invalid or overflow occurred). The function's doc comment says "Assumes: value_1 is 120 bits" but this is not enforced. Current callers all enforce the precondition, but this is pure caller discipline with no defensive check inside `pack`. The finding is accurate. Adding `assert(value_1 < TWO_POW_120, internal_errors::PACK_OVERFLOW)` at the top of `pack` would improve robustness.

### H11-F6 (labeled as real bug): Biased Encryption Mask from enc_amount_hash.high

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Hunter 11 sets up Finding 6 as a "REAL BUG" but then correctly concludes inside the analysis "No cryptographic bug." The bias from `P mod 2^128` in the low 128 bits of a uniformly-distributed felt252 is on the order of 2^−187, well below 2^−128 security. Using only `.low` as the 128-bit mask is standard practice. The "missed hardening opportunity" observation has no security impact. This is correctly non-exploitable and should be classified as informational or non-finding.

### H11-F7: _apply_write_once Storage Aliasing

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Hunter 11 itself correctly concluded this is not a bug after analysis. The storage address derives from a Pedersen-based deterministic path, `Note.token` vs. `packed_value` slot handling is intentional by design. Confirmed non-issue.

### H11-F8: _deposit_to_open_note Direct Write Bypasses WriteOnce

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Hunter 11 correctly identified this as intentional design: open notes have a two-phase lifecycle (creation then deposit). The `NOTE_ALREADY_DEPOSITED` check enforces single-deposit semantics. The asymmetry between encrypted notes (truly immutable) and open notes (two-phase) is by design. Non-issue.

### H11-F9: Missing Test Coverage for hash.low == 0

**Verdict: CONFIRMED**  
**Severity: INFO**

The test gap exists as described. No security impact, but a mock-hash test asserting correct round-trip when mask is zero would improve coverage.

---

## H12 — Hunter 12 (SNIP-12 signature verification, snip12.cairo)

### H12-B1: check_ecdsa_signature Panics on Zero Public Key

**Verdict: CONFIRMED**  
**Severity: MEDIUM (downgraded from full MEDIUM given off-chain-only scope)**

Verified from `snip12.cairo:54`:
```cairo
if check_ecdsa_signature(message_hash, signer_public_key, signature_r, signature_s) {
```
There is no guard `signer_public_key != 0` before the call. Cairo's `core::ecdsa::check_ecdsa_signature` is a VM builtin that attempts to decompress the given x-coordinate as a point on the Stark curve. A zero x-coordinate does not yield a valid point on the Stark curve, and the builtin will panic rather than return false.

The critical scope context (confirmed by Hunter 12's own research and my verification via `grep` of all `.cairo` files in `packages/privacy/src/`): `verify_depositor_validation` is not called from the on-chain privacy contract (`privacy.cairo`, `actions.cairo`, `interface.cairo`, `objects.cairo` — none import or reference `snip12`). It is used exclusively off-chain by the elliptic-proxy depositor screening service. An on-chain panic is therefore not directly exploitable against the privacy contract.

However, in the off-chain context: if a misconfigured or adversarial depositor supplies `signer_public_key = 0` to the off-chain verification path, the service would panic/crash rather than returning `Err(InvalidSignature)`. This violates the documented error contract and could cause a service availability issue. Severity is MEDIUM in the context of the off-chain service, but effectively INFO for the on-chain contract's security. The fix (add a zero-key guard) is trivial and correct.

### H12-B2: signer Used as SNIP-12 Account Address Slot

**Verdict: CONFIRMED (design choice, not exploitable)**  
**Severity: INFO**

Verified: `compute_message_hash` at `snip12.cairo:67–79` places `signer_public_key` (the raw curve x-coordinate) in the position where standard SNIP-12 expects the account contract address. This is a deliberate, self-consistent deviation: all three reference implementations (Cairo, TypeScript `elliptic-proxy/src/signing.ts`, Python `scripts/address_validation_signer/py/validation_signer.py`) agree on this layout, confirmed by cross-language reference vectors in `test_screening_vectors.cairo`. There is no exploitability. The footgun risk (a developer expecting standard wallet signing to work) is real but informational. Hunter 12's assessment is accurate.

### H12-B3: issued_at Type Mismatch (u128 in TYPE_HASH vs u64 in struct)

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Verified: The code at `snip12.cairo:14–22` explicitly documents the widening from `u64` to `u128` in the type hash string. Both representations reduce to the same felt252 element for any value in the u64 range (< 2^64 << P). The comment correctly explains the OZ `Permit` convention compatibility. Cross-language vectors confirm agreement. Not a bug.

### H12-B4: Timestamp Overflow with max_age = u64::MAX

**Verdict: REJECTED (Not a Bug)**  
**Severity: INFO**

Verified: `snip12.cairo:46–50` — the `FutureDated` guard at line 46 ensures `now >= issued_at` before the subtraction at line 49, making `now - issued_at` safe from underflow. `max_age = u64::MAX` results in effectively no expiry, which is a degenerate but valid policy for the caller. The function's documentation gap (not mentioning this behavior) is minor. Non-exploitable.

### H12-B5: SNIP12_VERSION = 2 Integer vs Shortstring '2'

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Verified: `snip12.cairo:9` uses integer `2`, correctly matching SNIP-12 revision-1 convention. The comment confirms this explicitly. Cross-language reference vectors confirm byte-level agreement. Not a bug.

### H12-B6: verify_depositor_validation Not Used On-Chain

**Verdict: CONFIRMED (scope clarification, not a bug report)**  
**Severity: INFO**

Verified independently: grepping all `.cairo` files in `packages/privacy/src/` (excluding `snip12.cairo` and test files) returns only `lib.cairo:8` declaring `pub mod snip12` as a module. The `privacy.cairo`, `actions.cairo`, `interface.cairo`, and `objects.cairo` files contain zero references to `snip12`, `verify_depositor_validation`, or `DepositorValidation`. This finding is an accurate scope boundary clarification that appropriately downgrades the severity of H12-B1 from affecting on-chain security to off-chain service availability.

### H12-B7: get_tx_info().unbox().chain_id in Domain Hash

**Verdict: REJECTED (Not a Bug)**  
**Severity: —**

Verified: Standard SNIP-12 behavior. Binding to chain_id from the transaction context provides replay protection across networks. Not a bug.

### H12 Additional: Degenerate Signature Components (signature_s = 0)

**Verdict: SUSPECTED**  
**Severity: LOW**

Not an original numbered finding but worth noting. Hunter 12 correctly observes that Cairo's `check_ecdsa_signature` may panic rather than return false when `signature_r = 0` or `signature_s = 0`, by the same mechanism as the zero public key issue. This is plausible given that both r and s must be in the valid range for the ECDSA builtin, but I have not confirmed the exact VM behavior for `s = 0` vs. graceful false return. If it panics, this compounds H12-B1 as a class of denial-of-service risk in the off-chain service.

---

## Summary Table

| Finding | Hunter | Verdict | Severity |
|---------|--------|---------|----------|
| H9-F1: y-coordinate ambiguity in ECDH | 9 | REJECTED | — |
| H9-F2: Cross-layer y-coordinate convention mismatch | 9 | CONFIRMED | INFO |
| H9-F3: ephemeral_secret = curve order causes panic | 9 | CONFIRMED | LOW |
| H9-F4: derive_public_key uniqueness for canonical keys | 9 | REJECTED | — |
| H9-F5: Same shared_x for two fields with distinct tags | 9 | REJECTED | — |
| H9-F6: channel_key = 0 if Poseidon outputs zero | 9 | SUSPECTED | INFO |
| H10-F1: NOTE_ID_TAG structural prefix of NULLIFIER_TAG | 10 | CONFIRMED | INFO |
| H10-F2: channel_key not validated non-zero (UseNote + OpenSubchannel) | 10 | CONFIRMED | LOW |
| H10-F3: outgoing_channel_id vs channel_key structural overlap | 10 | REJECTED | — |
| H10-F4: enc_token vs note_id length match | 10 | REJECTED | — |
| H10-F5: No cross-function domain-separation test suite | 10 | CONFIRMED | INFO |
| H10-F6: enc_amount_hash vs nullifier structurally identical | 10 | CONFIRMED | INFO |
| H11-F1: unpack panic on external packed_value | 11 | REJECTED (accurate) | — |
| H11-F2: _encrypt_note_amount hash.low == 0 degenerate case | 11 | CONFIRMED (INFO only) | INFO |
| H11-F3: OPEN_NOTE_PACKED_VALUE felt252 range | 11 | REJECTED (accurate) | — |
| H11-F4: decode_note_amount open note semantics | 11 | REJECTED (accurate) | — |
| H11-F5: pack missing runtime assertion for value_1 < TWO_POW_120 | 11 | CONFIRMED | LOW |
| H11-F6: enc_amount_hash.high bias (labeled "REAL BUG") | 11 | REJECTED | — |
| H11-F7: _apply_write_once storage aliasing | 11 | REJECTED (accurate) | — |
| H11-F8: _deposit_to_open_note bypasses write-once | 11 | REJECTED (accurate) | — |
| H11-F9: Missing test for hash.low == 0 | 11 | CONFIRMED | INFO |
| H12-B1: check_ecdsa_signature panics on zero public key | 12 | CONFIRMED | MEDIUM (off-chain) / INFO (on-chain) |
| H12-B2: signer in account address slot (SNIP-12 deviation) | 12 | CONFIRMED (design) | INFO |
| H12-B3: issued_at type mismatch u128 vs u64 | 12 | REJECTED | — |
| H12-B4: Timestamp overflow with max_age = u64::MAX | 12 | REJECTED | INFO |
| H12-B5: SNIP12_VERSION integer vs shortstring | 12 | REJECTED | — |
| H12-B6: verify_depositor_validation not used on-chain | 12 | CONFIRMED (scope note) | INFO |
| H12-B7: chain_id binding in domain hash | 12 | REJECTED | — |
| H12-Additional: Degenerate signature_s = 0 panic | 12 | SUSPECTED | LOW |

---

## Top Confirmed Bugs

Ranked by confidence and security impact:

**1. H12-B1 — check_ecdsa_signature panics on zero public key (MEDIUM)**  
`snip12.cairo:54`. No guard before calling the ECDSA builtin with a zero public key. Will panic (not return `InvalidSignature`) in the off-chain depositor screening service if a zero key is supplied. Fix: add `if signer_public_key == 0 { return Err(ValidationError::InvalidSignature); }` before the call. Straightforward and confirmed from source.

**2. H10-F2 — channel_key not validated non-zero in UseNoteInput and OpenSubchannelInput (LOW)**  
`actions.cairo:175–179` and `actions.cairo:68–77`. Both implementations explicitly ignore `channel_key` in their destructuring (`channel_key: _`). Hash function preconditions require non-zero inputs but are not enforced at the input-validation layer. Also confirmed by Hunters 2 and 5. Real defense-in-depth gap.

**3. H9-F3 — ephemeral_secret equal to curve order causes self-DoS panic (LOW)**  
`utils.cairo:100–113`. The curve order n is a valid non-zero `felt252` value (confirmed: `0 < n < P`), so `is_non_zero()` check passes. However `n*G` equals the identity, causing `.try_into().expect()` to panic. Affects any action using ECDH with `random = n`. Self-inflicted revert only.

**4. H11-F5 — pack missing runtime assertion for value_1 < TWO_POW_120 (LOW)**  
`utils.cairo:306–309`. The `pack` function relies entirely on caller discipline for its 120-bit precondition. No assertion inside the function. Current callers are correct, but future callers could violate this silently. Adding `assert(value_1 < TWO_POW_120)` is a simple, low-risk improvement.

**5. H9-F2 — Cross-layer y-coordinate convention mismatch, undocumented (INFO)**  
`utils.cairo:108` and `decryption.rs:41`. The Cairo and Rust sides use different y-coordinate conventions for `new_from_x` without a comment explaining the x-only ECDH invariant that makes them equivalent. A future implementation could introduce a real bug trying to "fix" this perceived inconsistency.

**6. H12-Additional — Degenerate signature (r=0 or s=0) may panic (SUSPECTED LOW)**  
Same class of issue as H12-B1. The ECDSA builtin behavior for zero signature components is not tested; it may panic rather than returning false, which would cause the off-chain screening service to crash rather than return `InvalidSignature`.
