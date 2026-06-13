# Hunter 9 Findings

**Scope:** `packages/privacy/src/utils.cairo` — `_compute_shared_x`, `encrypt_channel_info`, `encrypt_private_key`, `encrypt_user_addr`, `encrypt_subchannel_info`, `derive_public_key`; `packages/privacy/src/hashes.cairo` — `compute_channel_key`; `crates/discovery-core/src/privacy_pool/decryption.rs` — `decrypt_channel_info`.

---

## Finding 1: y-Coordinate Ambiguity in ECDH — NOT a Bug (Investigated, Closed)

**Claim under investigation:** `EcPointTrait::new_from_x(x)` returns one of two possible points with the given x-coordinate. If it picks the "wrong" y, the encryption and decryption would compute different shared secrets, making the data unreadable.

**Verdict: Not a bug.**

**Explanation:**

The protocol uses *x-coordinate-only* ECDH throughout. For any elliptic curve point P = (x, y), its negation is −P = (x, −y) (same x, opposite y). For any scalar r:

```
x-coord(r * P) = x-coord(r * (−P)) = x-coord(−(r * P))
```

because negating a point on an elliptic curve only flips y, leaving x unchanged. Therefore, whether `new_from_x` returns (x, y) or (x, −y), scalar-multiplying by the ephemeral secret and taking the x-coordinate of the result always produces the same value.

Concretely:

- **Encryption** (`_compute_shared_x`): `new_from_x(recipient_public_key)` recovers either `kG` or `−kG`. Then `r * (±kG)` = `±(rkG)`, x-coord = `(rkG).x`.
- **Decryption** (Cairo test utils `_find_shared_x`): `new_from_x(ephemeral_pubkey)` recovers either `rG` or `−rG`. Then `k * (±rG)` = `±(krG)`, x-coord = `(krG).x`.
- **Decryption** (Rust `decrypt_channel_info`): `AffinePoint::new_from_x(&ephemeral_pubkey, false)` recovers `±rG`. Same argument applies.

All three always agree on `shared_x = (rkG).x`. The existing round-trip tests (`test_encrypt_channel_info_decrypt`, `test_encrypt_private_key_decrypt`, `test_decrypt_channel_info_with_cairo_vectors`) confirm this in practice.

---

## Finding 2: Cross-Layer y-Coordinate Convention Mismatch — Documentation Gap

**Files:**
- `packages/privacy/src/utils.cairo:108` (`_compute_shared_x`)
- `packages/privacy/src/tests/utils_for_tests.cairo:2500` (`_find_shared_x`)
- `crates/discovery-core/src/privacy_pool/decryption.rs:41` (`decrypt_channel_info`)

**Severity: Informational / Documentation**

**Description:**

Although the x-only ECDH property means y-coordinate selection does not affect correctness (see Finding 1), there is a subtle but unacknowledged cross-layer discrepancy:

- Cairo `EcPointTrait::new_from_x` picks one of the two y values by an internal convention not documented in the codebase.
- Rust `AffinePoint::new_from_x(&x, false)` picks the *even* y explicitly (the `false` sign parameter).

Neither the contract code nor the Rust decryption code has a comment explaining *why* the y-coordinate choice doesn't matter and *why* the two sides use different conventions. A future reader (or a new implementation of decryption) may add an incorrect assumption that both sides must use the same y, then introduce a real bug trying to "fix" it. The existing tests only use one fixed test vector, so they would not catch an inconsistency introduced in a new implementation.

**Recommendation:** Add a comment at each `new_from_x` call site explaining:
1. That x-only ECDH is intentional.
2. That the y-coordinate choice does not affect the shared x because `x-coord(r*P) = x-coord(r*(−P))`.
3. That both sides (encryption and decryption) are therefore correct regardless of which y is chosen.

---

## Finding 3: ephemeral_secret Equal to Curve Order Causes Panic (Self-DoS)

**File:** `packages/privacy/src/utils.cairo:100–113` (`_compute_shared_x`)

**Severity: Low (user-controlled self-DoS, no security breach)**

**Description:**

`_compute_shared_x` asserts that `ephemeral_secret` is non-zero as a felt252. However, felt252 values range from 0 to P−1 (where P is the Stark field prime). The Stark curve group order n satisfies n < P, so n is a valid non-zero felt252 value.

If `ephemeral_secret = n` (the curve group order), then `GEN_P().mul(scalar: n)` = `n * G` = the point at infinity. The subsequent `.try_into().expect(ZERO_EPHEMERAL_PUBLIC)` panics.

**Trigger path:**
1. User submits any action that uses ECDH (SetViewingKey, OpenChannel, Withdraw, CreateOpenNote).
2. User sets `random = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f` (the curve order n).
3. Transaction panics with `ZERO_EPHEMERAL_PUBLIC`.

**Impact:** The user's own transaction reverts. No state is written. No other user is affected. The error is recoverable (user resubmits with a valid random value). This is a self-inflicted revert, not an attack on other users.

**Note:** The same issue applies to `ephemeral_secret` values that are multiples of n within the felt252 range, but since n ≈ P/2 there are at most 1 such non-zero multiple (namely n itself, since 2n > P).

**Recommendation:** Add a check `assert(random.into() < CURVE_ORDER, INVALID_RANDOM)` in each `InputValidation::assert_valid` implementation that includes a `random` field. Alternatively, document that values equal to the curve order will cause a benign panic.

---

## Finding 4: derive_public_key x-Coordinate Uniqueness for Canonical Keys (Verified Correct)

**Claim under investigation:** Could two different canonical private keys map to the same x-coordinate, breaking public key uniqueness and enabling account hijacking?

**Verdict: Not a bug.**

**Explanation:**

The contract enforces `is_canonical_key(key: user_private_key)` in `main()`, which asserts `key < ORDER / 2`. For any canonical key k (with k < n/2), the complementary key n − k satisfies n − k > n/2 and is therefore *not* canonical. The two keys share the same x-coordinate of their respective public key points (`kG` and `(n−k)G = −kG` have the same x). Since only one of the two is canonical, no two canonical keys share the same public key x-coordinate.

The uniqueness argument holds: `k1 * G` and `k2 * G` have the same x-coordinate if and only if `k2 = n − k1`, but then exactly one of k1, k2 is less than n/2 (canonical) and the other is greater.

---

## Finding 5: encrypt_channel_info Uses Same shared_x for Two Fields with Distinct Tags (Correct)

**Claim under investigation:** `encrypt_channel_info` encrypts both `enc_channel_key` and `enc_sender_addr` using the same `shared_x`. If the hash function collides on the two different tag inputs, ciphertext could leak structure.

**Verdict: Not a bug.**

**Explanation:**

The two masks are `h(ENC_CHANNEL_KEY_TAG, shared_x)` and `h(ENC_SENDER_ADDR_TAG, shared_x)`. The domain-separation constants are `'ENC_CHANNEL_KEY_TAG:V1'` and `'ENC_SENDER_ADDR_TAG:V1'` — distinct felt252 values. Poseidon hash collision between these two inputs would require breaking the Poseidon sponge function, which is computationally infeasible.

---

## Finding 6: encrypt_subchannel_info Uses a Zero channel_key If Poseidon Outputs Zero (Theoretical)

**File:** `packages/privacy/src/utils.cairo:83–88` (`encrypt_subchannel_info`); `packages/privacy/src/hashes.cairo:103–115` (`compute_channel_key`)

**Severity: Theoretical / Negligible**

**Description:**

`compute_channel_key` returns a raw Poseidon hash with no zero-check on the result. The function `encrypt_subchannel_info` documents "Assumes all the inputs (except index) are not zero" but there is no on-chain enforcement that the `channel_key` argument is non-zero. If the Poseidon hash of (CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr, recipient_public_key) happens to equal zero, then `encrypt_subchannel_info` is called with `channel_key = 0`, violating its documented precondition.

The probability of any specific Poseidon output being zero is approximately 1/p ≈ 2^−252, which is cryptographically negligible. No practical attack exists.

**Recommendation:** This is informational. If defensive programming is desired, an `assert(channel_key.is_non_zero(), ...)` could be added after `compute_channel_key` at the call site, to fail loudly rather than violate a documented assumption.

---

## Summary Table

| # | Area | Status | Severity |
|---|------|--------|----------|
| 1 | y-Coordinate Ambiguity in ECDH Decryption | **Not a Bug** | — |
| 2 | Cross-Layer y-Coordinate Convention Mismatch | **Documentation Gap** | Informational |
| 3 | ephemeral_secret = Curve Order causes panic | **Real Issue** | Low (self-DoS) |
| 4 | derive_public_key Uniqueness for Canonical Keys | **Not a Bug** | — |
| 5 | Same shared_x for two encrypted fields | **Not a Bug** | — |
| 6 | channel_key = 0 if Poseidon outputs zero | **Theoretical** | Negligible |
