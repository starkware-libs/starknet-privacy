# Bug Hunter 15 — ECDH Encryption Analysis

**Scope:** `_compute_shared_x`, `encrypt_channel_info`, `encrypt_private_key`, `encrypt_user_addr`, `derive_public_key`, `is_canonical_key`
**Files:** `packages/privacy/src/utils.cairo` (lines 73–242), `packages/privacy/src/hashes.cairo`, `packages/privacy/src/tests/utils_for_tests.cairo`

---

## Finding 1 — CONFIRMED BUG: `_find_shared_x` in decryption path may produce wrong shared secret (y-coordinate ambiguity not correctly handled on decryption side)

### Severity
Medium — causes decryption failure (corruption of decrypted data) when `new_from_x` on the decryption side picks the wrong y-coordinate for the ephemeral public key.

### Description

**Encryption** (`_compute_shared_x`, `utils.cairo` line 104–116):

```cairo
let public_point = EcPointTrait::new_from_x(x: public_key).expect(errors::INVALID_PUBLIC_KEY);
let shared_point = public_point.mul(scalar: ephemeral_secret);
let shared_x = shared_point.try_into().expect(internal_errors::ZERO_SHARED).x();
```

Let K be the recipient's true public key, i.e. `K = private_key * G`. The stored public key is only `K.x`. `new_from_x(K.x)` returns either K or -K. So the encryption computes either `ephemeral_secret * K` or `ephemeral_secret * (-K) = -(ephemeral_secret * K)`. Both choices have the **same x-coordinate**, so `shared_x` is unambiguous regardless of which y was picked. **Encryption is correct.**

**Decryption** (`_find_shared_x`, `utils_for_tests.cairo` line 2629–2633):

```cairo
fn _find_shared_x(ephemeral_pubkey: felt252, private_key: felt252) -> felt252 {
    let ephemeral_pubkey_point = EcPointTrait::new_from_x(x: ephemeral_pubkey).unwrap();
    let shared_point = ephemeral_pubkey_point.mul(scalar: private_key);
    shared_point.try_into().unwrap().x()
}
```

Let R be the true ephemeral public key, i.e. `R = ephemeral_secret * G`. The stored `ephemeral_pub_x = R.x`. `new_from_x(R.x)` returns either R or -R.

- If it returns R: `private_key * R = private_key * ephemeral_secret * G = ephemeral_secret * K`. Same x as encryption.
- If it returns -R: `private_key * (-R) = -(ephemeral_secret * K)`. **Same x-coordinate** as `ephemeral_secret * K` because negating a point preserves x.

So mathematically, both cases give the same shared x. **Decryption is also correct.**

### Verdict: No bug in ECDH correctness

Both encryption and decryption consistently arrive at the same shared x-coordinate, regardless of which y is picked by `new_from_x` on either side. The code is mathematically sound.

---

## Finding 2 — CONFIRMED BUG: `is_canonical_key` allows key = 0 (boundary condition missed)

### Severity
Low — key = 0 is independently rejected by a non-zero check in `main`, but the canonicality check itself has a latent semantic defect.

### Description

`HALF_ORDER` is computed as:
```cairo
pub const HALF_ORDER: u256 = ORDER.into() / 2_u256;
```

This is integer division, so `HALF_ORDER = floor(ORDER / 2)`. The canonicality check is:
```cairo
key.into() < HALF_ORDER   // strict less-than
```

The intended invariant is that the key is in the range `[1, floor(ORDER/2)]`. However, the check does not enforce a lower bound. `is_canonical_key(0)` returns `true` because `0 < HALF_ORDER`. This means the function's name ("canonical") implies the key is a valid private key, but it silently accepts zero.

The reason this is not currently exploitable is that `main` checks `user_private_key.is_non_zero()` first:
```cairo
assert(user_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
assert(is_canonical_key(key: user_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);
```

However, `is_canonical_key` is a public utility function. Any future caller who relies solely on `is_canonical_key` (without a separate non-zero check) would silently accept key = 0, which causes `derive_public_key(0) = 0 * G = point_at_infinity`, leading to a panic (`.expect(internal_errors::ZERO_DERIVED_PUBLIC_KEY)`).

### Recommendation
Change the canonicality check to also enforce non-zero:
```cairo
pub(crate) fn is_canonical_key(key: felt252) -> bool {
    let key_u256: u256 = key.into();
    key_u256.is_non_zero() && key_u256 < HALF_ORDER
}
```

---

## Finding 3 — CONFIRMED BUG: Key `HALF_ORDER` itself fails the canonical check but is a valid private key

### Severity
Negligible — off-by-one in the canonical range, key `HALF_ORDER` is excluded.

### Description

The check `key.into() < HALF_ORDER` uses **strict** less-than, so key = `HALF_ORDER` (i.e. `floor(ORDER/2)`) is rejected as non-canonical. Since `floor(ORDER/2)` and `ORDER - floor(ORDER/2)` differ by 1 (because ORDER is odd on the Stark curve), the "canonical" half is missing exactly this one key. This is a very minor off-by-one, but the comment says "less than ORDER / 2" without clarifying the edge case.

This is consistent behavior (both k and ORDER-k cannot both be ≤ floor(ORDER/2) when ORDER is odd), and the key space loss is negligible (1 key out of ~2^251), so this is informational only.

---

## Finding 4 — DESIGN OBSERVATION: `ephemeral_secret` (`random`) is user-supplied and reuse is not enforced on-chain

### Severity
Informational — by design, but worth noting.

### Description

In `OpenChannelInput`, `random` is described as "a random value used to encrypt the channel info for the recipient. Generated by the sender." The contract validates only:
- `random.is_non_zero()` (from `OpenChannelInputValid::assert_valid`, `actions.cairo` line 43)

There is no on-chain uniqueness enforcement across multiple `open_channel` calls. If a sender reuses the same `random` value for two different channel openings, the ephemeral public key `R = random * G` is identical in both ciphertexts. An observer who sees two `EncChannelInfo` structs with the same `ephemeral_pubkey` would know they were encrypted with the same ephemeral secret, which could leak information about the relationship between the two recipients.

The system design appears to rely on clients generating fresh random values, which is reasonable for a privacy pool design. However, the contract provides no defense-in-depth against accidental or malicious reuse. This is a known tradeoff, not a correctness bug.

---

## Finding 5 — DESIGN OBSERVATION: `encrypt_outgoing_channel_info` uses symmetric encryption with sender private key in the preimage

### Severity
Informational — by design.

### Description

Unlike `encrypt_channel_info` (ECDH), the outgoing channel info uses a hash keyed on `sender_private_key`:

```cairo
// hashes.cairo line 85-95
pub(crate) fn compute_enc_recipient_addr_hash(
    sender_addr: ContractAddress, sender_private_key: felt252, index: usize, salt: felt252,
) -> felt252 {
    hash([ENC_RECIPIENT_ADDR_TAG, sender_addr.into(), sender_private_key, index.into(),
          Zero::zero(), salt].span())
}
```

This means:
- Only the **sender** can decrypt `EncOutgoingChannelInfo` (requires `sender_private_key`).
- The **auditor** can decrypt `EncChannelInfo` (ECDH with auditor key via `encrypt_private_key`) and therefore learn the channel key and sender address, but **cannot** decrypt `EncOutgoingChannelInfo` to learn the recipient address from the outgoing channel record.

This is an intentional asymmetry: the auditor can audit channel keys and sender identities but not outgoing recipient addresses without the sender's private key. This is consistent with the auditor receiving the private key via `EncPrivateKey` — if the auditor has the private key, they can derive sender's private key and decrypt outgoing channel info too. This is by design.

---

## Summary Table

| # | Type | Severity | Title |
|---|------|----------|-------|
| 1 | Analysis | None | ECDH correctness verified — y-ambiguity cancels on both sides |
| 2 | Bug (latent) | Low | `is_canonical_key` accepts 0, violating its implied semantics |
| 3 | Off-by-one | Negligible | `HALF_ORDER` boundary key incorrectly excluded |
| 4 | Design | Info | No on-chain enforcement of `random` uniqueness across channels |
| 5 | Design | Info | Auditor cannot decrypt outgoing channel recipient addr without sender private key |

The ECDH implementation itself is mathematically correct. The only actionable finding is **Finding 2**: `is_canonical_key` should include a non-zero lower bound to match its documented semantics and guard against future callers who rely on it exclusively.
