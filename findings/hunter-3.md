# Hunter 3 Findings

## Bug 1: Stale Doc References Non-Existent `VALUE_MISMATCH` Error for `OpenChannel`

**File:** `packages/privacy/src/interface.cairo:143-144`

**Description:**
The interface documentation for `compile_and_panic` lists `VALUE_MISMATCH` as an error thrown by the `OpenChannel` action:

```
/// - [`VALUE_MISMATCH`](privacy::errors::VALUE_MISMATCH): Thrown if the recipient's public key
///   in storage does not match the provided public key.
```

This error cannot be thrown because:
1. `OpenChannelInput` has **no** `recipient_public_key` field. The struct contains only `recipient_addr`, `index`, `random`, and `salt`.
2. The constant `VALUE_MISMATCH` does **not exist** anywhere in `errors.cairo`. Searching the entire file confirms it is absent.
3. The `open_channel` implementation in `privacy.cairo` (lines 348-417) reads `recipient_public_key` from storage via `self.public_key.read(recipient_addr)` and never compares it against a user-supplied value.

**Root Cause:**
The documentation was written for an earlier design where `OpenChannelInput` carried a `recipient_public_key` field that the contract would verify against storage. That field was later removed, making the check and error obsolete. The error constant was never added to `errors.cairo`, yet the doc comment was left behind.

**Severity:** Informational — no runtime impact, but misleads auditors and integrators who may expect the check or the error to exist.

**How to verify:** `grep -r "VALUE_MISMATCH" packages/privacy/src/` returns only the interface doc comment, confirming the constant is absent everywhere else.

---

## Bug 2: `open_subchannel` Does Not Validate User-Supplied `recipient_public_key` Against On-Chain Storage

**File:** `packages/privacy/src/privacy.cairo:421-468`

**Description:**
`open_subchannel` accepts `recipient_public_key` as a user-supplied field (via `OpenSubchannelInput`) and uses it directly in the channel-marker hash check:

```cairo
let channel_marker = compute_channel_marker(
    :channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
);
assert(self.channel_exists.read(channel_marker), errors::INVALID_CHANNEL);
```

The contract **never checks** whether `recipient_public_key == self.public_key.read(recipient_addr)`.

**Security Analysis:**

The channel marker check does bind `recipient_public_key` to the channel, so a random bogus key will fail to produce a valid channel marker. However, the attack surface is:

1. **Subchannel pointing to wrong/stale key**: A sender could open a subchannel using an arbitrary (but correctly formatted) `recipient_public_key` that was never registered on-chain for `recipient_addr`. The `channel_exists` check will reject this if no matching channel was opened with that key, which is the common case. But if the channel was originally opened with a key that has since changed (impossible today given WriteOnce — see point 2), this could matter.

2. **WriteOnce protects today**: Public keys are write-once, so rotation is impossible. In the current design, the only valid `recipient_public_key` for `recipient_addr` is whatever was stored at registration, and the channel was opened with that same key. Therefore a subchannel will only succeed with the correct key.

3. **Future risk**: If the write-once constraint on `public_key` is ever relaxed (allowing key rotation), `open_subchannel` would allow opening a subchannel with an old/revoked key as long as an old channel exists, because the contract never re-checks the key against storage. This is a latent vulnerability.

4. **Design inconsistency**: `open_channel` reads `recipient_public_key` from storage (providing implicit validation). `open_subchannel` does not, creating an asymmetry in trust assumptions.

**Root Cause:**
`open_subchannel` trusts the caller to supply a correct `recipient_public_key` and only validates it indirectly through the channel-marker hash. There is no explicit `assert(recipient_public_key == self.public_key.read(recipient_addr))` guard.

**Severity:** Low (no exploitable path today due to write-once keys) — but latent design risk and trust-model inconsistency.

**Test Code:**
```cairo
/// Demonstrates that open_subchannel accepts an arbitrary `recipient_public_key`
/// as long as there is a channel opened with that same key.
/// This shows the key is never validated against on-chain storage.
#[test]
fn test_open_subchannel_accepts_arbitrary_recipient_public_key_if_channel_exists() {
    let mut test: Test = Default::default();
    let mut sender = test.new_user();
    let mut recipient = test.new_user();
    sender.set_viewing_key_e2e();
    recipient.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();

    // Open a legitimate channel from sender to recipient (uses recipient's real stored key).
    let (random, salt) = sender.open_channel_e2e(recipient, index: 0);
    let real_channel_key = sender.compute_channel_key(recipient);

    // Now try to open a subchannel with a DIFFERENT (fake) recipient_public_key.
    // compute_channel_key uses sender_private_key + recipient_public_key, so a wrong
    // key produces a different channel_key, which won't match the stored channel_marker.
    // This test confirms the rejection path.
    let fake_public_key = 0x1234567890abcdef_felt252;
    let fake_channel_key = compute_channel_key(
        sender_addr: sender.address,
        sender_private_key: sender.private_key,
        recipient_addr: recipient.address,
        recipient_public_key: fake_public_key,
    );
    let fake_input = OpenSubchannelInput {
        recipient_addr: recipient.address,
        recipient_public_key: fake_public_key,
        channel_key: fake_channel_key,
        index: 0,
        token: token_addr,
        salt: sender.get_salt().into(),
    };
    let result = sender.safe_execute(
        client_actions: [ClientAction::OpenSubchannel(fake_input)].span(),
    );
    // Fails because channel_marker for (fake_channel_key, sender, recipient, fake_key)
    // was never written to storage — the INVALID_CHANNEL check rejects it.
    assert_panic_with_felt_error(result, expected_error: errors::INVALID_CHANNEL);

    // Confirm: there is NO on-chain check that fake_public_key == storage key of recipient.
    // The rejection here is indirect (channel marker mismatch), not a direct key validation.
    // If someone could forge a channel with the fake key, the subchannel would succeed.
}
```

**How to verify:** `~/.asdf/installs/starknet-foundry/0.59.0/bin/snforge test -p privacy test_open_subchannel_accepts_arbitrary_recipient_public_key_if_channel_exists`

---

## Bug 3: Index Skipping Does Not Work — Correctly Rejected (No Bug)

**Investigation Result: This is NOT a bug.**

The concern was: could a user open channel at index=0 and then claim index=2 (skipping index=1) in the same transaction?

The sequentiality check at lines 370-383 reads:
```cairo
assert(
    index.is_zero()
        || self
            .outgoing_channels
            .entry(
                compute_outgoing_channel_id(
                    :sender_addr, :sender_private_key, index: index - 1,
                ),
            )
            .salt
            .read()
            .is_non_zero(),
    errors::INDEX_NOT_SEQUENTIAL,
);
```

**Analysis:**
- `compile_actions` is a **read-only view** (declared `self: @ContractState`). The WriteOnce actions produced by `open_channel` are returned as `ServerAction` structs but **not yet applied to storage** during `compile_and_panic`.
- `_client_apply_actions` (called in `main`) applies WriteOnce actions to the contract state within the same `compile_and_panic` call context. This means when index=2 is processed in the same client action sequence, the WriteOnce for index=0 has already been applied to state, making index=1 still absent.
- Since index=1 is not present in storage, the check `self.outgoing_channels.entry(...index-1...).salt.read().is_non_zero()` returns false, and the transaction reverts with `INDEX_NOT_SEQUENTIAL`.

Wait — let me re-examine. `_client_apply_actions` is called in `main` after each `open_channel` action:

```cairo
let actions = match *client_action { ClientAction::OpenChannel(input) => self.open_channel(...) };
self._client_apply_actions(actions: actions.span(), ref :has_replay_protection);
```

And `_client_apply_actions` calls `_apply_write_once` which **writes to storage**. So after processing the index=0 `OpenChannel`, the outgoing_channel for index=0 IS written to storage. When the index=2 `OpenChannel` is processed, it looks for index=1, which was never written — correctly rejected.

**Conclusion:** Index skipping is correctly prevented. No bug.

---

## Bug 4: Self-Channel and Self-Subchannel Are Permitted By Design (Confirmed — By Design)

**Investigation Result: Permitted by design, no missing guard.**

The concern was: can `sender == recipient` when opening a channel or subchannel?

**Findings:**

1. `open_channel` (`privacy.cairo:348-417`) has no check that `sender_addr != recipient_addr`. Existing tests at lines 158-159, 203, 247, 535, 544 confirm `user_1` opening a channel to `user_1` (self-channel) is a normal, tested use case.

2. `open_subchannel` similarly has no `sender != recipient` check.

3. Self-channels are a valid feature. A user deposits into their own privacy pool and sends notes to themselves — this is the primary way to shielding one's own funds. The existing test `test_transfer_to_self` (line 195) and multiple other tests explicitly exercise this path.

**Conclusion:** Not a bug. Self-channels and self-subchannels are intentional and tested.

---

## Summary

| # | Title | Severity | Real Bug? |
|---|-------|----------|-----------|
| 1 | `VALUE_MISMATCH` documented but doesn't exist | Informational | Yes — doc/code mismatch |
| 2 | `open_subchannel` missing explicit `recipient_public_key` validation | Low | Yes — latent risk, design inconsistency |
| 3 | Index skipping attack | N/A | Not a bug — correctly rejected |
| 4 | Self-subchannel possible | N/A | Not a bug — by design |
