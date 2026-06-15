# Hunter 8 Findings — `snip12.cairo` Security Audit

**File:** `/home/user/starknet-privacy/packages/privacy/src/snip12.cairo`
**Reviewer:** Hunter 8
**Date:** 2026-06-15

---

## Summary

Reviewed the SNIP-12 screening attestation implementation end-to-end, tracing through `snip12.cairo`, `_verify_screening` in `privacy.cairo` (lines 861–889), the unit test suite (`test_snip12.cairo`), and the committed cross-language vectors (`screening_vectors.cairo`). Found one moderate-severity issue (signature malleability with no `s`-canonicality check), one confirmed-intentional deviation from standard SNIP-12 (public key vs. account address), one documented-but-worth-flagging type mismatch (`u64` vs. `u128`), and one test-coverage gap.

---

## Finding 1: No Canonicality Check on Signature `s` — Signature Malleability Not Mitigated (Moderate)

**Severity:** Moderate
**Status:** Real issue, no mitigation in the code

### Description

The STARK curve ECDSA implementation used by Cairo's `check_ecdsa_signature` builtin accepts **both** `(r, s)` and `(r, N - s)` as valid signatures for the same message, where `N` is the curve order. This is the classic ECDSA malleability property: given one valid signature, an attacker can derive a second valid signature for the same message without knowing the private key.

The codebase is aware of this property and defends against it in a different context: `is_canonical_key` in `utils.cairo` enforces `key < HALF_ORDER` for user private keys (line 241). However, **no equivalent check is applied to the attestation signature's `s` component** when validating screening attestations.

```cairo
// snip12.cairo line 47-48
let (r, s) = attestation.signature;
check_ecdsa_signature(message_hash, signer_public_key, r, s)
// No check: s < HALF_ORDER (or s < ORDER)
```

### Impact

For each legitimate screener-signed attestation `(r, s)`, an attacker can compute `(r, N - s)` and submit it as an alternative valid attestation for the **same depositor and the same `issued_at`**. Concretely:

1. The attacker observes a valid attestation `(issued_at, r, s)` used in a successful `apply_actions` transaction (these are on-chain / in mempool).
2. They compute `(r, N - s mod N)` — trivially computed as `felt252` arithmetic.
3. They craft a new `apply_actions` call with the malleable variant `(issued_at, r, N - s)`.

The impact on screening integrity depends on whether signatures can be replayed. Since the same attestation covers the same `(depositor, issued_at)` pair, a malleable variant can be used to submit an otherwise-identical deposit transaction in a situation where the on-chain transaction might be replayed (e.g., in a re-org scenario, or if replay-protection via `WriteOnce` is not always present in every actions batch).

More critically: **if the freshness window (300 seconds) is still open**, the attacker can use the malleable `s` to generate a second valid-looking signature. In practice this does not bypass the screener's intent for the current transaction, but it undermines the non-repudiation property of SNIP-12 attestations — two distinct "signatures" exist for every screener approval.

### What the Standard Expects

SNIP-12 (like EIP-712) does not mandate low-`s` canonicality, but the rest of this codebase explicitly enforces it for private keys. The inconsistency is surprising: user private keys are checked for `< HALF_ORDER`, but screener signature `s` values are not. This asymmetry is a latent risk, especially if future logic (e.g., a screening-attestation revocation list or deduplication mechanism) relies on signature uniqueness.

### Recommendation

Add a canonicality check on `s` before calling `check_ecdsa_signature`:

```cairo
pub fn is_screening_attestation_valid(
    depositor: ContractAddress, attestation: ScreeningAttestation, signer_public_key: felt252,
) -> bool {
    let (r, s) = attestation.signature;
    // Reject the high-s form to prevent malleable variants of the same signature.
    if !is_canonical_sig_s(s) {
        return false;
    }
    let validation = DepositorValidation { depositor, issued_at: attestation.issued_at };
    let message_hash = compute_message_hash(@validation, signer_public_key);
    check_ecdsa_signature(message_hash, signer_public_key, r, s)
}
```

Where `is_canonical_sig_s(s)` checks `s.into() < HALF_ORDER` (same pattern as `is_canonical_key`).

### Test Coverage Gap

The unit tests in `test_snip12.cairo` test tampered `r` (`signature_r + 1`, line 85) but **do not test tampered `s`**. There is no test for `(r, N - s)` to confirm whether it is accepted or rejected. A test asserting it returns `false` should be added — and currently it would return `true` (the bug is present).

---

## Finding 2: SNIP-12 Deviation — Signer Public Key Used Instead of Account Address (Informational, Intentional)

**Severity:** Informational
**Status:** Intentional by design per code comment; confirmed by test vectors

### Description

Standard SNIP-12 (per OZ's reference implementation and the EIP-712 analog) places the **account address** (a `ContractAddress`) in the third slot of the hash:

```
h('StarkNet Message', domain_hash, account_address, message_hash)
```

This implementation places the **screener's raw public key** (a `felt252`) in that slot:

```cairo
// snip12.cairo lines 64–69
PoseidonTrait::new()
    .update_with('StarkNet Message')
    .update_with(domain.hash_struct())
    .update_with(signer)           // signer = public key (felt252), not ContractAddress
    .update_with(validation.hash_struct())
    .finalize()
```

The code comment on `compute_message_hash` explicitly states: *"signer is the trusted signer's STARK-curve public key (felt252). The SNIP-12 envelope binds the hash to this identity."*

### Evidence from Test Vectors

All three vectors in `screening_vectors.cairo` use a `signer_public_key` field directly (e.g., `0x7f1fff02c3801d82c9b233faefb45f99631c4c85a3325b785884e38ee56ae46`). The test in `test_snip12.cairo` line 32 passes `key.public_key` directly to `compute_message_hash`. The off-chain vector generator also uses the public key, not an account address. The intent is fully consistent.

### Implication

Any off-chain signer (TypeScript/Python) that follows the SNIP-12 standard and substitutes the account address instead of the public key will produce a hash that does not match the on-chain verifier. The signing tool must explicitly use the public key in slot 3. This is non-standard and must be documented prominently for integrators.

**This is intentional by design** — the screener is identified by public key, not account address, because the screener may not have a StarkNet account. However, it is a deviation that could cause silent integration failures for off-chain tools that follow the SNIP-12 spec verbatim.

### Recommendation

Add a prominent warning to `compute_message_hash`'s doc comment and any external integration guide noting that slot 3 is `public_key` not `account_address`, breaking from the standard. The current doc comment is correct but brief; it should explicitly say "this is NOT the account address" to prevent mistakes.

---

## Finding 3: Type Hash Says `u128`, Struct Field Is `u64` (Informational, Documented, Harmless)

**Severity:** Informational
**Status:** Documented and harmless in practice; confirmed by code comment

### Description

```cairo
pub const DEPOSITOR_VALIDATION_TYPE_HASH: felt252 = selector!(
    "\"DepositorValidation\"(\"depositor\":\"ContractAddress\",\"issued_at\":\"u128\")",
);

pub struct DepositorValidation {
    pub depositor: ContractAddress,
    pub issued_at: u64,  // u64 in Cairo, u128 in the type string
}
```

The type hash declares `issued_at` as `u128`, but the actual struct field is `u64`. When `hash_struct` is computed, the `u64` is serialized to `felt252` via the `Hash` trait. The code comment on line 11–13 explains this:

> SNIP-12 has no `u64` primitive; the type string widens `issued_at` to `u128`, while the Cairo field stays `u64`. Both reduce to the same felt under Poseidon, so the encoding matches off-chain signers that follow OZ's `Permit` convention.

The claim is correct: a `u64` value serialized to `felt252` and a `u128` value with the same 64-bit quantity serialized to `felt252` produce identical field elements, since both types fit in felt252's 252-bit range.

### Implication

The type hash string does not accurately describe the Cairo struct. If a future auditor or integrator generates the type hash from the Cairo source rather than from the explicit constant, they would compute a different hash. The approach is safe today but creates a documentation hazard.

### Recommendation

No code change required given the existing comment. Consider renaming the field to `issued_at_u128` or adding a `#[allow(type_mismatch)]`-style comment block explaining the deliberate widening. The existing comment is adequate but easy to miss.

---

## Finding 4: Timestamp `issued_at: 0` Accepted by Tests Without Expiry (Informational, Test Issue)

**Severity:** Informational
**Status:** Test code only — does not affect production logic

### Description

Several tests use `issued_at: 0` in screening attestations (e.g., `test_deposit_with_valid_screening_passes` at line 2246, `test_UNEXPECTED_SCREENING_fails` at line 2285, `test_deposit_depositor_mismatch_fails` at line 2352).

This works because snforge's default block timestamp is `0` in tests that do not call `start_cheat_block_timestamp`. With `now = 0` and `issued_at = 0`:
- `issued_at <= now` → `0 <= 0` → passes
- `now - issued_at = 0 <= 300` → passes

The production contract would reject `issued_at = 0` on any real network where the block timestamp is in Unix time (well above 300 seconds since epoch). The tests are therefore passing for reasons that do not hold in production — they rely on snforge's zero-timestamp default rather than testing with realistic timestamps.

### Impact

This is not a production vulnerability; the freshness checks (`SCREENING_FUTURE_DATED`, `SCREENING_EXPIRED`) are correctly tested in `test_deposit_stale_screening_fails` and `test_deposit_future_dated_screening_fails` with `start_cheat_block_timestamp`. However, the `issued_at: 0` pattern in other tests masks that those tests don't actually exercise the freshness path at all.

### Recommendation

Replace `issued_at: 0` in tests that aren't specifically about expiry with a realistic `issued_at: get_block_timestamp()` (mirroring the `_auto_screening` helper pattern in `utils_for_tests.cairo` line 1675). This makes the tests more representative of production behaviour.

---

## Finding 5: No Replay of Attestation Across Block Timestamps — Correct (Non-Issue)

**Status:** Not a bug; design is correct

### Description

One might wonder whether an attacker can reuse a previously-seen attestation `(issued_at = T)` after the 300-second window closes by replaying it in a new transaction. The check `now - attestation.issued_at <= 300` correctly rejects any such replay once the window closes. The `issued_at` is part of the signed message, so the attacker cannot increment it without the screener's key. This is sound.

---

## Finding 6: `_verify_screening` — Arithmetic Underflow Cannot Occur (Non-Issue)

**Status:** Not a bug

### Description

The check `now - attestation.issued_at <= DEPOSITOR_VALIDATION_MAX_AGE` is guarded by the prior assertion `attestation.issued_at <= now`. In Cairo, unsigned subtraction panics on underflow, but since `issued_at <= now` is enforced first, the subtraction is always safe. No issue.

---

## Appendix: Key File Locations

- `snip12.cairo`: `/home/user/starknet-privacy/packages/privacy/src/snip12.cairo`
- `_verify_screening`: `/home/user/starknet-privacy/packages/privacy/src/privacy.cairo` lines 861–889
- `is_canonical_key`: `/home/user/starknet-privacy/packages/privacy/src/utils.cairo` lines 239–241
- Unit tests: `/home/user/starknet-privacy/packages/privacy/src/tests/test_snip12.cairo`
- Cross-language vectors: `/home/user/starknet-privacy/packages/privacy/src/tests/screening_vectors.cairo`
- Server tests: `/home/user/starknet-privacy/packages/privacy/src/tests/test_server.cairo` lines 2231–2560
