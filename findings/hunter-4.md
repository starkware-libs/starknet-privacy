# Security Audit Findings — Hunter 4
## Contract: `packages/privacy/src/privacy.cairo`
## Focus: `set_viewing_key`, `open_channel`, `open_subchannel`

---

## Finding 1 (CONFIRMED BUG): `open_subchannel` does not require the sender to prove knowledge of the sender's private key

**Severity:** Medium  
**Location:** `open_subchannel` (lines 426–475), `open_channel` (lines 352–424)

### Description

In `open_channel`, the sender proves knowledge of their private key explicitly:

```cairo
let sender_public_key = self.public_key.read(sender_addr);
assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
assert(
    sender_public_key == derive_public_key(private_key: sender_private_key),
    errors::SENDER_NOT_AUTHENTICATED,
);
```

In `open_subchannel`, there is **no equivalent authentication**. The sender provides `channel_key` directly and the only check is:

```cairo
let channel_marker = compute_channel_marker(
    :channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
);
assert(self.channel_exists.read(channel_marker), errors::INVALID_CHANNEL);
```

The `channel_key = h(CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr, recipient_public_key)` is a hash that requires knowing `sender_private_key` to compute. However, `channel_key` is **transmitted to the recipient** in the `enc_channel_info` (encrypted with the recipient's public key) during `open_channel`.

Once the recipient decrypts `enc_channel_info`, they learn `channel_key`. While they cannot call `open_subchannel` with `sender_addr = actual_sender` (since `sender_addr` in `open_subchannel` comes from `user_addr`, which is the authenticated account address), an entity that has acquired `channel_key` by any means could potentially interfere if they could forge `sender_addr`.

More importantly, the `channel_key` is also available to the auditor (who knows all private keys). The auditor can compute `channel_key` for any pair, and — since `open_subchannel` does not require proof of `sender_private_key` — the auditor (or anyone with access to the sender's private key) could open new subchannels for any existing channel without the original sender's explicit action.

### Concrete scenario

1. Auditor decrypts `enc_private_key` for sender Alice.
2. Auditor computes `channel_key` for Alice→Bob channel.
3. Auditor (controlling an account with address == Alice's address, e.g. after a key compromise) calls `open_subchannel(sender_addr=Alice, channel_key=..., recipient=Bob, token=MALICIOUS_TOKEN)`.
4. A subchannel marker is written for (Alice, Bob, MALICIOUS_TOKEN) without Alice's intent.

**Key observation:** Unlike `open_channel`, `open_subchannel` only uses `sender_addr` (not `sender_private_key`) to identify the sender. Knowledge of `channel_key` is sufficient to open subchannels on an existing channel. The channel_key is derivable by anyone who knows `sender_private_key` (auditor, or an attacker who compromised Alice's key).

### Severity justification

In the normal threat model where users hold their private keys, this is not exploitable since `channel_key` is secret. However:
- If a private key is compromised, the attacker can open subchannels in Alice's name without triggering `SENDER_NOT_AUTHENTICATED`
- The auditor has a structural capability to open subchannels for all users

### Recommended fix

Add a private-key authentication check to `open_subchannel`, similar to `open_channel`:

```cairo
let sender_public_key = self.public_key.read(sender_addr);
assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
assert(
    sender_public_key == derive_public_key(private_key: sender_private_key),
    errors::SENDER_NOT_AUTHENTICATED,
);
```

This would require `open_subchannel` to also accept `sender_private_key` as a parameter (analogously to `open_channel`).

---

## Finding 2 (CONFIRMED BUG): `open_channel` allows sender == recipient (self-channel)

**Severity:** Low  
**Location:** `open_channel` (lines 352–424)

### Description

`open_channel` does not check `recipient_addr != sender_addr`. A user can open a channel to themselves.

When `sender_addr == recipient_addr`:
1. `recipient_public_key = self.public_key.read(recipient_addr)` reads the sender's own public key.
2. `channel_key = h(CHANNEL_KEY_TAG, sender_addr, sender_private_key, sender_addr, sender_public_key)`.
3. The `channel_marker` binds this channel_key with `sender_addr` appearing twice.
4. The `Append` action adds `enc_channel_info` to **the sender's own** `recipient_channels` Vec.

This creates an anomaly: the user appears in their own channel list as a recipient. While not immediately exploitable, it produces data that may confuse off-chain clients scanning the channel list. The recipient sees themselves as a potential sender in a channel that was self-addressed.

More concretely, a user could deposit a note into a self-channel's subchannel and then use it themselves — effectively a no-op that occupies note index slots. This burns subchannel and note slots without any counterparty.

### Additional note: `open_subchannel` validation also misses this check

`OpenSubchannelInputValid::assert_valid` does not check `recipient_addr != sender_addr`. However, since `open_subchannel`'s `sender_addr` comes from `user_addr`, this can only produce a self-subchannel if the self-channel was first opened.

### Recommended fix

Add `assert(sender_addr != recipient_addr, errors::SELF_CHANNEL)` to `open_channel` and `assert(sender_addr != recipient_addr)` to `OpenChannelInputValid::assert_valid`.

---

## Finding 3 (CONFIRMED NOT A BUG): `channel_key` is deterministic — only one channel per (sender, recipient) pair

**Severity:** N/A  
**Location:** `open_channel` (lines 392–395), `hashes.cairo:compute_channel_key`

### Analysis

`channel_key = h(CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr, recipient_public_key)` is deterministic for a fixed sender/recipient pair.

`channel_marker = h(CHANNEL_MARKER_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key)` is also deterministic.

A second call to `open_channel` for the same (sender, recipient) pair produces the same `channel_marker` and same `outgoing_channel_id` (for the same `index`).

The `WriteOnce(channel_marker)` in `_client_apply_actions` would detect the existing marker and panic, causing the entire compile_and_panic sub-call to revert. This prevents duplicate channel creation.

However, the `Append(enc_channel_info)` action is processed BEFORE `WriteOnce(channel_marker)` in `_client_apply_actions`. Could this leave the Vec polluted after the WriteOnce panic?

**No.** The `_client_apply_actions` call runs inside `compile_and_panic`, which is called via `call_contract_syscall`. When the inner call panics, StarkNet reverts ALL storage changes from that inner call, including the Vec append. The outer call's storage is untouched. **No bug.**

---

## Finding 4 (CONFIRMED NOT A BUG): Sequential index check for `open_channel` is correctly enforced same-transaction

**Severity:** N/A  
**Location:** `open_channel` (lines 377–390), `_client_apply_actions` (lines 709–730)

### Analysis

When a sender opens two channels in the same transaction (e.g., index 0 then index 1 to different recipients), the sequential check for index 1 reads `outgoing_channels[index=0].salt`. During compile_and_panic, the WriteOnce for index 0 runs in `_client_apply_actions` BEFORE the sequential check for index 1 runs in the second `open_channel` call. So the check correctly sees the storage written by the first action. **No bug.**

---

## Finding 5 (CONFIRMED NOT A BUG): `open_subchannel` `recipient_public_key` is validated indirectly via `channel_marker`

**Severity:** N/A  
**Location:** `open_subchannel` (lines 436–440)

### Analysis

The user-provided `recipient_public_key` in `open_subchannel` is validated by:
1. Computing `channel_marker = h(CHANNEL_MARKER_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key)`.
2. Asserting `channel_exists[channel_marker]`.

Since `channel_marker` was set by `open_channel` using the `recipient_public_key` from storage (which was written during `set_viewing_key` as `derive_public_key(private_key)`), the user-provided `recipient_public_key` must match the registered key. An attacker cannot substitute a different public key without breaking the marker check. **No bug.**

---

## Finding 6 (CONFIRMED NOT A BUG): `set_viewing_key` key immutability

**Severity:** N/A  
**Location:** `set_viewing_key` (lines 308–350)

### Analysis

Both `WriteOnce(public_key)` and `WriteOnce(enc_private_key)` ensure the viewing key is set exactly once. If a user attempts to re-register, `_apply_write_once` reads the existing non-zero value and panics with `NON_ZERO_VALUE`. This correctly enforces immutability. **No bug.**

Note: if the auditor public key changes via `set_auditor_public_key`, old `enc_private_key` ciphertexts remain encrypted under the old auditor key and cannot be decrypted with the new key. This is a design limitation, not a bug.

---

## Finding 7 (CONFIRMED NOT A BUG): `_apply_write_once` partial-zero field check

**Severity:** N/A  
**Location:** `_apply_write_once` (lines 891–906)

### Analysis

`_apply_write_once` asserts `value[0].is_non_zero()` before iterating and checking/writing ALL fields. This means:
1. The first field acts as the existence sentinel (must be non-zero).
2. All fields are individually checked to be zero in storage before writing.

For `EncOutgoingChannelInfo { salt, enc_recipient_addr }`: `salt` (field 0) is guaranteed non-zero by validation. Even if `enc_recipient_addr` happened to be zero (extraordinarily unlikely but theoretically possible via `h(...) + recipient_addr ≡ 0`), the second field would be written as zero. A subsequent WriteOnce to the same address would check field 0 (salt, non-zero) and correctly panic. The zero in field 1 cannot be exploited to re-write that field, because the WriteOnce correctly checks ALL fields in sequence and the first non-zero field aborts any re-write attempt.

For `EncSubchannelInfo { salt, enc_token }` and `EncPrivateKey { auditor_public_key, ephemeral_pubkey, enc_private_key }`: same reasoning applies. **No bug.**

---

## Finding 8 (DESIGN NOTE): `open_subchannel` channel_key not validated as non-zero

**Severity:** None  
**Location:** `OpenSubchannelInputValid::assert_valid` (actions.cairo lines 68–78)

### Analysis

`channel_key` is not validated as non-zero in `assert_valid`. If `channel_key = 0`, then:
- `channel_marker = h(CHANNEL_MARKER_TAG, 0, sender_addr, recipient_addr, recipient_public_key)` would be computed.
- `channel_exists[channel_marker]` would be false (this value was never set by `open_channel`, since `channel_key` in `open_channel` is computed from a hash and cannot be zero).
- The `INVALID_CHANNEL` assertion fires.

No exploitable path exists: a zero `channel_key` cannot pass the `channel_exists` check. However, adding an explicit check `assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY)` would improve defensive coding. This is a minor style/defense-in-depth issue, not a security bug.

---

## Summary Table

| # | Category | Verdict | Severity |
|---|----------|---------|----------|
| 1 | `open_subchannel` doesn't authenticate sender's private key | **REAL BUG** | Medium |
| 2 | `open_channel` allows self-channel (`sender == recipient`) | **REAL BUG** | Low |
| 3 | Deterministic channel_key: double-open prevention via WriteOnce | Not a bug | — |
| 4 | Same-tx sequential index check for outgoing channels | Not a bug | — |
| 5 | `recipient_public_key` validated indirectly via channel_marker | Not a bug | — |
| 6 | `set_viewing_key` key immutability | Not a bug | — |
| 7 | `_apply_write_once` partial-zero field handling | Not a bug | — |
| 8 | `channel_key` not explicitly checked as non-zero | Design note only | — |
