# Hunter 12 Findings — `packages/privacy/src/snip12.cairo`

## Summary of investigated bugs

Seven candidate bugs were listed. Below is the verdict on each, ordered by severity.

---

## Bug 1 (REAL — Medium): `check_ecdsa_signature` panics on zero public key

**File:** `packages/privacy/src/snip12.cairo:54`

```cairo
if check_ecdsa_signature(message_hash, signer_public_key, signature_r, signature_s) {
```

**Description:**

`core::ecdsa::check_ecdsa_signature` is a Cairo builtin that maps directly to the underlying VM hint. The STARK-curve ECDSA verifier requires the public key to be a non-zero point on the curve. When `public_key = 0`, the builtin attempts to decompress the point `(0, ?)` off the curve, which fails with a runtime panic (not a graceful `false` return).

There is **no guard** that `signer_public_key != 0` before calling `check_ecdsa_signature`. Any caller that passes `signer_public_key = 0` (e.g., a misconfigured or adversarial off-chain component) will crash the entire execution rather than receiving an `InvalidSignature` error.

**Impact:**

`verify_depositor_validation` is currently only called off-chain (via the elliptic-proxy / discovery service), so an on-chain panic is not directly exploitable against the privacy contract itself. However, if this function is ever integrated on-chain, passing zero as the signer key would abort the transaction unconditionally rather than returning `Err(InvalidSignature)`. This violates the documented contract (`InvalidSignature` is the expected return for any bad key/signature) and could cause DoS if `signer_public_key` is taken from external input without prior validation.

**Evidence:** No zero-key test exists. The test suite (`test_snip12.cairo`) only tests with valid random keys generated via `KeyPairTrait::from_secret_key`, which never produce 0.

**Recommendation:** Add a guard before `check_ecdsa_signature`:

```cairo
if signer_public_key == 0 {
    return Err(ValidationError::InvalidSignature);
}
```

And add a corresponding test:
```cairo
#[test]
fn test_zero_public_key_returns_invalid_signature() {
    setup_chain_id();
    let validation = sample_validation();
    let result = verify_depositor_validation(
        validation, (1, 1), 0, ISSUED_AT, MAX_AGE,
    );
    assert!(result == Err(ValidationError::InvalidSignature));
}
```

---

## Bug 2 (REAL — Low / Design gap): `signer` used as SNIP-12 account address slot — non-standard but intentional

**File:** `packages/privacy/src/snip12.cairo:77`

```cairo
.update_with(signer)
```

**Description:**

SNIP-12 standard positions `account_address` (the caller's contract address) as the third element of the outer Poseidon hash. Here the code places `signer_public_key` (a raw x-coordinate felt) in that slot instead. This is a deliberate deviation documented in the comment: "The SNIP-12 envelope binds the hash to this identity."

**Is it actually a bug?**

Technically, this is not a correctness bug in isolation — the hash is self-consistent across all three signers (Cairo, TypeScript `elliptic-proxy/src/signing.ts`, and Python `scripts/address_validation_signer/py/validation_signer.py`). All three agree on the layout. Cross-language reference vectors in `packages/privacy/src/tests/screening_vectors.cairo` are verified by `test_committed_screening_vectors_validate`, confirming bit-for-bit agreement.

**Residual risk:** Standard SNIP-12 wallets (Argent, Braavos) build the hash using the account *contract address* in that slot. A holder of a regular StarkNet account who tries to sign a `DepositorValidation` using their wallet's built-in SNIP-12 UI will produce a different hash, because the wallet inserts the contract address, not the raw public key. This makes it **impossible** to use standard wallet UIs for signing without custom tooling. This is likely intentional (the signer is the off-chain screening oracle, not a user wallet), but it is a footgun if the design ever changes to allow user-wallet signing.

**Verdict:** Design choice, not a bug. No code change needed, but the comment should explicitly warn that standard wallet signing will not work.

---

## Bug 3 (NOT a bug): `issued_at` type mismatch between TYPE_HASH (`u128`) and struct field (`u64`)

**File:** `packages/privacy/src/snip12.cairo:14–22`

```cairo
pub const DEPOSITOR_VALIDATION_TYPE_HASH: felt252 = selector!(
    "\"DepositorValidation\"(\"depositor\":\"ContractAddress\",\"issued_at\":\"u128\")",
);

pub struct DepositorValidation {
    pub depositor: ContractAddress,
    pub issued_at: u64,   // ← u64, not u128
}
```

**Analysis:**

The TYPE_HASH encodes `issued_at` as `u128` in the encodeType string (for off-chain compatibility where SNIP-12 has no `u64` primitive). The Cairo field is `u64`. When Cairo's `#[derive(Hash)]` hashes a `u64`, it serializes the value as a single felt252 (via `Into<u64, felt252>`). An off-chain u128 signer encodes the same integer as a single felt252 with high-order bits zero. For all values representable in u64 (< 2^64 << p), both produce the same felt252 element.

The comment in the code already explains this: "Both reduce to the same felt under Poseidon, so the encoding matches off-chain signers that follow OZ's `Permit` convention."

This is correctly handled. **Not a bug.**

---

## Bug 4 (NOT a bug): Timestamp overflow — `now - issued_at > max_age` with `max_age = u64::MAX`

**File:** `packages/privacy/src/snip12.cairo:46–50`

```cairo
if validation.issued_at > now {
    return Err(ValidationError::FutureDated);
}
if now - validation.issued_at > max_age {
    return Err(ValidationError::Expired);
}
```

**Analysis:**

After the `FutureDated` guard, `now >= issued_at` is invariant, so `now - issued_at` is a valid u64 subtraction (no underflow). If `max_age = u64::MAX`, then `now - issued_at` can be at most `u64::MAX - 0 = u64::MAX`, making `> u64::MAX` always false — effectively no expiry.

This is degenerate behavior but not exploitable in a harmful way: the caller who constructs `max_age` controls whether expiry is enforced. Passing `u64::MAX` as `max_age` is equivalent to "never expire," which is a valid (if unusual) policy choice for the caller. The current deployment (elliptic-proxy) uses a fixed small `max_age`.

**Not a bug** in the implementation; however, the function's doc comment does not mention the degenerate `max_age = u64::MAX` behavior. A caller who accidentally passes `u64::MAX` intending "maximum strictness" would be surprised. Minor documentation gap only.

---

## Bug 5 (NOT a bug): `SNIP12_VERSION = 2` numeric vs shortstring `'2'`

**File:** `packages/privacy/src/snip12.cairo:8–9`

```cairo
// Numeric felt (not shortstring `'2'`), matching the starknet.js/starknet-py convention.
pub const SNIP12_VERSION: felt252 = 2;
```

**Analysis:**

The SNIP-12 revision-1 specification (used by OZ, starknet.js, starknet-py) encodes `version` as the *integer* 2, not the shortstring `'2'` (which equals `0x32`). Using `2` (the integer) is correct for SNIP-12 revision 1. The comment correctly documents the choice. Both off-chain signers use the same constant. The cross-language test vectors confirm agreement. **Not a bug.**

---

## Bug 6 (NOT a bug, but important scope note): `verify_depositor_validation` is NOT used by the on-chain privacy contract

**Analysis:**

Searching the entire `packages/privacy/src/` tree (all `.cairo` files) for `snip12`, `verify_depositor_validation`, and `DepositorValidation`, the only files that reference these identifiers are:

- `snip12.cairo` (definition)
- `tests/test_snip12.cairo` (unit tests)
- `tests/test_screening_vectors.cairo` (cross-language vector tests)
- `tests.cairo` and `lib.cairo` (module declarations)

The main contract `privacy.cairo`, `actions.cairo`, `interface.cairo`, and `objects.cairo` do **not** import or use `snip12` at all. The verification is performed entirely off-chain by the `elliptic-proxy` service before allowing a depositor through.

**Security implication:** Bugs in `snip12.cairo` do **not** affect on-chain privacy guarantees. They only affect the off-chain depositor screening gate. If the screening service were compromised or bypassed, the privacy contract itself would still function correctly — it is agnostic to depositor identity validation.

This is an important scope boundary for the audit: `snip12.cairo` is infrastructure for the off-chain oracle, not the on-chain core.

---

## Bug 7 (NOT a bug): `get_tx_info().unbox().chain_id` in domain hash

**File:** `packages/privacy/src/snip12.cairo:71`

```cairo
chain_id: get_tx_info().unbox().chain_id,
```

**Analysis:**

Binding the hash to `chain_id` from the current transaction's context provides correct replay protection across networks: a signature issued for Sepolia is rejected on Mainnet because the chain_id differs. This is the standard SNIP-12 behavior and is intentional. **Not a bug.**

---

## Additional observation: Missing test for `signature_s = 0` / degenerate signature components

The test suite covers tampered `r` (incremented by 1) but does not test `(0, 0)` or `(r, 0)` signatures. Cairo's `check_ecdsa_signature` builtin requires both `r` and `s` to be non-zero and in the valid curve range; passing zeros may panic rather than return false — the same class of issue as the zero public key. This is worth testing to confirm graceful `InvalidSignature` behavior vs. panic.

---

## Files examined

- `/home/user/starknet-privacy/packages/privacy/src/snip12.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/tests/test_snip12.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/tests/test_screening_vectors.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/tests/screening_vectors.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/privacy.cairo` (confirmed: no snip12 usage)
- `/home/user/starknet-privacy/elliptic-proxy/src/signing.ts`
- `/home/user/starknet-privacy/scripts/address_validation_signer/py/validation_signer.py`
