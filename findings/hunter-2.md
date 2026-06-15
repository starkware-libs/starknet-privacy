# Bug Hunter #2 Findings — `hashes.cairo`

Focus area: domain separation tags, hash function usage, and hash collision risks.

---

## Finding 1: `sender_private_key` used as encryption key material in `compute_enc_recipient_addr_hash` — leaks private-key oracle to salt observer

**Severity: High**

**File:** `packages/privacy/src/hashes.cairo`, lines 85–95; `packages/privacy/src/utils.cairo`, lines 124–136

**Description:**

`compute_enc_recipient_addr_hash` is defined as:

```
h(ENC_RECIPIENT_ADDR_TAG, sender_addr, sender_private_key, index, 0, salt)
```

This hash is used as the one-time-pad for encrypting `recipient_addr`:

```
enc_recipient_addr = h(..., sender_private_key, ...) + recipient_addr
```

The result is stored on-chain in `outgoing_channels: Map<felt252, EncOutgoingChannelInfo>`, which includes both `salt` and `enc_recipient_addr` as public storage.

The critical flaw: all inputs to the hash except `sender_private_key` are public or attacker-observable:
- `sender_addr` is the caller's own address — public.
- `index` is a sequential counter — public.
- `salt` is stored alongside `enc_recipient_addr` in `EncOutgoingChannelInfo` — public.
- `ENC_RECIPIENT_ADDR_TAG` is a constant.

This means that an observer who knows `sender_addr`, `index`, and `salt` (which they can read directly from chain) can enumerate candidate private keys and check:

```
enc_recipient_addr - recipient_addr_candidate == h(ENC_RECIPIENT_ADDR_TAG, sender_addr, k_candidate, index, salt)
```

If `recipient_addr` is also known (it is the address of an existing registered user), the attacker can brute-force `sender_private_key` by checking whether the equation holds for a candidate key. There is only ~126 bits of key space (the key is canonical, i.e., < ORDER/2), but even if brute-force is infeasible in practice, the structure is conceptually broken: the key material is directly exposed in a hash where every other input is known.

More concretely: the attacker can verify a guessed `sender_private_key` with a single hash evaluation, with no rate-limiting on-chain. A weak or poorly generated private key could be found in polynomial time.

**Contrast with other encryption functions:**

All other encryption functions in the codebase use ECDH:

- `encrypt_channel_info`: `h(ENC_CHANNEL_KEY_TAG, shared_x)` where `shared_x = (r * recipient_public_key).x` — unguessable without knowing the ephemeral secret `r`.
- `encrypt_private_key`: same ECDH construction.
- `encrypt_user_addr`: same ECDH construction.

`compute_enc_recipient_addr_hash` deviates from this pattern by using `sender_private_key` directly instead of an ECDH shared secret. The comment in `objects.cairo` (line 84) acknowledges `sender_private_key` is in the hash but does not discuss this exposure.

**Impact:**

- Leaks the sender's private key if any combination of `(sender_addr, index, salt, recipient_addr)` is known — and all four are observable on-chain.
- An attacker who recovers `sender_private_key` can: derive `channel_key` for all channels the sender has opened, decrypt all `EncChannelInfo` entries associated with the sender, compute all `note_id`s, and decrypt all note amounts.

**Root cause:**

The `ENC_RECIPIENT_ADDR_TAG` encryption was not designed using ECDH like the other encryption functions. Instead, it uses the private key as a symmetric key — but a symmetric key whose all other inputs (the "nonce" and "context") are public.

**Recommended fix:**

Use a fresh ECDH shared secret, analogous to `encrypt_channel_info`. Alternatively, derive the keystream from `channel_key` (which is a hash of the private key, not the private key itself) combined with `index` and `salt`, so that compromising the keystream does not directly expose the private key.

---

## Finding 2: Missing cross-function collision test — `compute_enc_token_hash` vs `compute_enc_amount_hash` share structural layout

**Severity: Low / Informational**

**File:** `packages/privacy/src/hashes.cairo`, lines 62–65 and 199–205

**Description:**

`compute_enc_token_hash` is:
```
h(ENC_TOKEN_TAG, channel_key, index, 0, salt)         // 5 elements
```

`compute_enc_amount_hash` is:
```
h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt) // 6 elements
```

These are structurally similar (both use `channel_key`, `index`, `0` placeholder, and `salt`). The domain tags differ (`ENC_TOKEN_TAG` vs `ENC_AMOUNT_TAG`), which prevents collisions under the preimage-resistance of Poseidon. However, the test suite (`test_hashes.cairo`) only tests that each function produces different outputs for different *inputs to the same function*. There is no test verifying that `compute_enc_token_hash(channel_key, index, salt)` never equals `compute_enc_amount_hash(channel_key, same_token, index, salt)` or any cross-function collision scenario.

This is a test coverage gap rather than an exploitable bug, but given the sensitivity of the protocol, cross-function collision tests (covering all pair combinations) would provide much stronger confidence. As written, a future hash function that accidentally reuses a tag or drops the domain tag would go undetected.

**Note:** The use of distinct tags (`ENC_TOKEN_TAG:V1` vs `ENC_AMOUNT_TAG:V1`) is correct by design. The concern is exclusively about test coverage.

---

## Finding 3: `compute_enc_token_hash` hardcoded zero at position 3 — positional ambiguity with `compute_note_id`

**Severity: Informational**

**File:** `packages/privacy/src/hashes.cairo`, lines 62–65

**Description:**

```cairo
pub(crate) fn compute_enc_token_hash(channel_key: felt252, index: usize, salt: felt252) -> felt252 {
    hash([ENC_TOKEN_TAG, channel_key, index.into(), Zero::zero(), salt].span())
}
```

The `Zero::zero()` at position 3 is undocumented. Compare with `compute_note_id`:

```
h(NOTE_ID_TAG, channel_key, token, index, 0)
```

In `compute_note_id` the zero is at position 4 and is explicitly documented as a "reserved zero placeholder for forward compatibility". In `compute_enc_token_hash` the zero is at position 3 and there is no docstring explaining its purpose (the function comment at line 62 shows the formula but does not explain why position 3 is zero while `salt` follows at position 4).

Given that `token` appears at position 2 in `compute_note_id` but is absent from `compute_enc_token_hash`, the zero at position 3 in `compute_enc_token_hash` looks like it was meant to be a `token` placeholder (it occupies the same slot as `token` in `compute_note_id` if you adjust for the different tag). If a future protocol upgrade were to add `token` at position 3 in `compute_enc_token_hash`, the hash would collide with `compute_note_id` output for any case where `index` == 0 and `salt` == 0. While those constraints mean collision is practically impossible in valid usage (index is sequential and salt must be non-zero), the lack of documentation creates a maintenance trap.

**Recommended fix:** Add a comment to `compute_enc_token_hash` explaining why position 3 is zero and what it reserves for, matching the documentation pattern of `compute_subchannel_id` and `compute_note_id`.

---

## Finding 4: Storage key collisions between different Maps are safe — confirmed non-issue

**Severity: None (confirmed safe)**

**Description:**

The contract stores data in multiple `Map<felt252, ...>` fields keyed by application-layer felt252 identifiers (`note_id`, `nullifier`, `channel_marker`, `subchannel_marker`, `outgoing_channel_id`). An analysis of whether a crafted input could make two of these keys collide was performed.

**Conclusion:** Even if two application-layer felt252 keys were equal (e.g., `note_id == channel_marker` for some inputs), Starknet storage layout is safe. Each `Map` field in the `Storage` struct occupies a distinct storage base derived from the field's position in the struct. The Starknet storage model computes each map entry's address as `h(map_base_address, key)`, so two maps with the same application-layer key would still resolve to different physical storage addresses. No cross-map collision is possible at the storage layer.

Furthermore, each of the seven application hash functions (`compute_note_id`, `compute_nullifier`, `compute_channel_marker`, `compute_subchannel_marker`, `compute_subchannel_id`, `compute_channel_key`, `compute_outgoing_channel_id`) uses a distinct domain tag, has a different input arity, or has structurally different inputs, making birthday-style collisions between outputs computationally infeasible under Poseidon's security assumptions.

---

## Finding 5: `compute_outgoing_channel_id` and `compute_enc_recipient_addr_hash` share the same secret inputs — correlation leaks channel linking info

**Severity: Medium**

**File:** `packages/privacy/src/hashes.cairo`, lines 120–131 and 85–95

**Description:**

`compute_outgoing_channel_id` is:
```
h(OUTGOING_CHANNEL_ID_TAG, sender_addr, sender_private_key, index, 0)
```

`compute_enc_recipient_addr_hash` is:
```
h(ENC_RECIPIENT_ADDR_TAG, sender_addr, sender_private_key, index, 0, salt)
```

Both functions take the exact same first four inputs (`sender_addr`, `sender_private_key`, `index`) after their respective tags. The `outgoing_channel_id` is stored as the map key in `outgoing_channels`, which is public. An observer can see which `outgoing_channel_id` values exist on-chain.

Now, from Finding 1 we know that an attacker who brute-forces `sender_private_key` using the `enc_recipient_addr` oracle can also compute all `outgoing_channel_id` values for that sender. The reverse is also interesting: because `outgoing_channel_id` is just `h(tag, sender_addr, private_key, index, 0)`, it acts as a zero-knowledge commitment to the private key *per index*. A single known `(outgoing_channel_id, sender_addr, index)` tuple combined with a guessed private key candidate can be verified against the id — giving yet another oracle for brute-forcing the private key, completely independent of the enc_recipient_addr data.

In short, `outgoing_channel_id` itself leaks the same oracle as Finding 1 — an attacker with a candidate `sender_private_key` can verify it against any `outgoing_channel_id` they observe on-chain with a single hash.

**Root cause:** Both the id and the encryption keystream are derived directly from `sender_private_key` rather than from a public commitment (like `sender_public_key`) or a one-time ECDH shared secret.

**Note:** This finding compounds Finding 1. The fix is the same: avoid exposing `sender_private_key` in any hash whose other inputs are fully public.

---

## Summary Table

| # | Title | Severity |
|---|-------|----------|
| 1 | `sender_private_key` as encryption key material in `compute_enc_recipient_addr_hash` | High |
| 2 | Missing cross-function hash collision tests | Low / Informational |
| 3 | Undocumented zero placeholder at position 3 in `compute_enc_token_hash` | Informational |
| 4 | Storage key collisions between Maps | None (safe) |
| 5 | `compute_outgoing_channel_id` is also a private-key brute-force oracle | Medium |
