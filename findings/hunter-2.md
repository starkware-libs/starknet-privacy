# Hunter 2 Findings

## Bug 1: Double-Spend Protection — Cross-Transaction Analysis (Not a Bug)

**File:** `packages/privacy/src/privacy.cairo:529-577`

**Description:**
The question was whether `use_note` lacking an explicit `self.nullifiers.read(nullifier).is_zero()` check before generating the WriteOnce action creates a double-spend vulnerability in subsequent transactions.

**Analysis (Not a Bug — Defence is Sound):**

The double-spend protection works correctly via `_apply_write_once` (lines 832-847). When `use_note` runs during compile phase for a subsequent transaction, it generates a `WriteOnce` server action targeting the nullifier storage slot. When `_apply_write_once` is executed (either during compile's `_client_apply_actions` loop, or during the server's `apply_actions`), it reads the current on-chain storage value at the nullifier address. If the nullifier was written by a previous transaction, `storage_read_syscall` returns non-zero and the assertion on line 841 panics with `NON_ZERO_VALUE`.

The `compile_and_panic` flow also applies WriteOnce during compile (via `_client_apply_actions` on line 292), so even a compile-phase call on a previously-nullified note reverts correctly.

**Verdict:** Sound. Double-spend is prevented for both same-transaction reuse (same `_client_apply_actions` call) and cross-transaction reuse (`_apply_write_once` reads storage).

---

## Bug 2: Missing `channel_key != 0` Validation in `UseNoteInput::assert_valid`

**File:** `packages/privacy/src/actions.cairo:175-179`

**Description:**
`UseNoteInput::assert_valid` only validates that `token` is non-zero. It does **not** check that `channel_key` is non-zero, despite the hash function documentation for `compute_note_id` and `compute_subchannel_marker` both stating "Assumes all the inputs are not zero."

**Root Cause:**
```cairo
pub(crate) impl UseNoteInputValid of InputValidation<UseNoteInput> {
    fn assert_valid(self: UseNoteInput) {
        let UseNoteInput { channel_key: _, token, index: _ } = self;
        assert(token.is_non_zero(), errors::ZERO_TOKEN);
        // channel_key: _ silently discards the value — no zero check.
    }
}
```

If `channel_key = 0`:
- `compute_subchannel_marker(0, owner_addr, owner_public_key, token)` produces a well-defined Poseidon hash. The `subchannel_exists` lookup for this marker would return false in all normal circumstances (nobody legitimately creates a subchannel with `channel_key=0`), so `use_note` would revert with `SUBCHANNEL_NOT_FOUND`.
- However, if an attacker can cause a storage slot to appear set for that subchannel_marker (e.g., through a hash collision or a specially crafted `open_subchannel` call using an artificially constructed channel_key that resolves to 0 — computationally infeasible but theoretically violates the documented invariant), `compute_note_id(0, token, index)` and `compute_nullifier(0, token, index, owner_private_key)` would also produce deterministic values.

**Severity:** Low / Defensive. No known exploitation path since `SUBCHANNEL_NOT_FOUND` guards the zero-channel_key case in practice, but the contract violates its own documented invariant ("Assumes all inputs are non-zero") and the sister inputs (like `OpenSubchannelInput`) do validate `channel_key` indirectly through the channel_marker lookup.

**Concrete Impact:** No immediate exploit. Inconsistency is a latent risk if hash domain separation or storage layout is ever changed, and it creates undefined-behavior territory per the function contracts.

**Test Code:**
```cairo
#[test]
fn test_use_note_zero_channel_key_reverts_subchannel_not_found() {
    // Demonstrates that passing channel_key=0 is not validated at the input
    // level but is caught by the SUBCHANNEL_NOT_FOUND guard.
    // A proper fix would add `assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY)`
    // to UseNoteInputValid::assert_valid.
    use privacy::actions::{ClientAction, UseNoteInput};
    use privacy::errors;
    use privacy::tests::utils_for_tests::{Test, TestTrait, UserTrait};
    use core::num::traits::Zero;
    use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let token_addr = test.mock_new_token();

    // channel_key=0 is not rejected by assert_valid (only token is checked).
    // The call proceeds past assert_valid but fails at SUBCHANNEL_NOT_FOUND,
    // confirming the missing input-level validation.
    let use_note_input = UseNoteInput { channel_key: Zero::zero(), token: token_addr, index: 0 };
    let result = user.safe_use_note(note: use_note_input);

    // Currently panics with SUBCHANNEL_NOT_FOUND (not ZERO_CHANNEL_KEY),
    // demonstrating there is no early input validation for channel_key=0.
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
}
```

**How to verify:**
```
cd packages/privacy && snforge test test_use_note_zero_channel_key_reverts_subchannel_not_found
```

---

## Bug 3: `use_note` Does Not Verify `derive_public_key(owner_private_key) == stored_public_key[owner_addr]` — Analysis

**File:** `packages/privacy/src/privacy.cairo:529-577`

**Description:**
`use_note` accepts an arbitrary `owner_private_key` from the caller and uses it to derive `owner_public_key` on the fly:

```cairo
let owner_public_key = derive_public_key(private_key: owner_private_key);
let subchannel_marker = compute_subchannel_marker(
    :channel_key,
    recipient_addr: owner_addr,
    recipient_public_key: owner_public_key,
    :token,
);
assert(self.subchannel_exists.read(subchannel_marker), errors::SUBCHANNEL_NOT_FOUND);
```

It never checks `self.public_key.read(owner_addr) == owner_public_key`.

**Analysis (Not an Exploitable Bug — But a Security-Relevant Design Gap):**

For this to be exploitable, an attacker (address A, registered key `pk_A`) would need to:
1. Find a `fake_private_key` such that `derive_public_key(fake_private_key) = pk_A'` where `pk_A' != pk_A`.
2. Have a subchannel in storage with marker `h(SUBCHANNEL_MARKER_TAG, channel_key, A, pk_A', token)` — i.e., a subchannel was opened to address A with key `pk_A'`.
3. Have a note at `compute_note_id(channel_key, token, index)`.

The only way a subchannel can exist with marker `(channel_key, A, pk_A', token)` is if a sender explicitly called `open_subchannel` providing `recipient_addr=A` and `recipient_public_key=pk_A'`. The `open_subchannel` code does not validate that `pk_A'` matches the registered key of address A (no check in `open_subchannel` that recipient_public_key == self.public_key.read(recipient_addr)).

This means:
- A malicious **sender** could open a subchannel to victim address A using a fake public key `pk_A'` of the sender's choosing.
- The sender could then create a note in that subchannel.
- The sender could immediately spend that note using `owner_private_key` corresponding to `pk_A'` — since the sender knows the fake private key.
- This is a **self-inflicted non-issue**: the sender loses their own funds, the victim (address A) cannot be made to spend anything they didn't authorize.

Alternatively: Can an attacker spend a **legitimate** note created for address A (with registered key `pk_A`)?
- The legitimate note is under subchannel_marker `h(..., channel_key, A, pk_A, token)`.
- To spend it, the attacker must provide `owner_private_key` such that `derive_public_key(owner_private_key) == pk_A`.
- This requires knowing `pk_A`'s private key — i.e., breaking the elliptic curve discrete log. Not feasible.

**Severity:** Informational / Design Note. No exploitable path exists in the current protocol because:
1. The sender who creates a subchannel with a fake recipient key only harms themselves (they pre-commit to a wrong key that only they know).
2. An attacker cannot pass the `subchannel_exists` check for a legitimate note without knowing the recipient's private key.

**However, the missing check creates a subtle coupling issue:**
- The nullifier `h(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)` depends on the key actually used to spend the note, not on the registered key.
- If the registered key check were added, the nullifier scheme would be more strongly tied to the identity binding. Its absence means that in principle, the same note could theoretically be spent with different private keys (producing different nullifiers) IF multiple subchannels with different public keys for the same address could coexist — which currently cannot happen for the same (channel_key, token) pair since the subchannel_marker is unique.

**Recommendation:** Add a defensive check:
```cairo
let registered_public_key = self.public_key.read(owner_addr);
assert(registered_public_key.is_non_zero(), errors::OWNER_NOT_REGISTERED);
assert(owner_public_key == registered_public_key, errors::OWNER_NOT_AUTHENTICATED);
```
This would harden the authentication chain and make the spending authorization explicitly tied to the registered identity, matching the pattern already used in `open_channel` (lines 358-363).

**Test Code demonstrating current behavior (uses a non-registered key successfully when subchannel uses matching fake key):**
```cairo
#[test]
fn test_use_note_does_not_verify_registered_public_key() {
    // Demonstrates that use_note does not check whether the private key
    // matches the address's registered public key. A user can spend a note
    // using any private key that matches the subchannel's public key,
    // even if that key is different from their registered key.
    use privacy::actions::{ClientAction, UseNoteInput};
    use privacy::tests::utils_for_tests::{Test, TestTrait, UserTrait};
    use privacy::utils::derive_public_key;

    let mut test: Test = Default::default();
    let mut user_1 = test.new_user(); // sender
    let mut user_2 = test.new_user(); // recipient with registered key pk_2

    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e(); // registers user_2.private_key -> user_2.public_key

    let token = test.new_token();
    let token_addr = token.contract_address();

    // user_1 opens a channel to user_2 using user_2's registered key.
    user_1.open_channel_with_token_e2e(recipient: user_2, :token_addr, outgoing_channel_index: 0);

    // user_1 creates a note for user_2.
    let amount = 1000_u128;
    let create_note_input = user_1
        .new_enc_note_with_generated_salt(recipient: user_2, :token_addr, :amount, index: 0);
    user_1.cheat_create_enc_note_e2e(:create_note_input);

    // user_2 spends the note using their REGISTERED private key (normal case).
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    let use_note_input = UseNoteInput { :channel_key, token: token_addr, index: 0 };
    let actions = user_2.use_note(note: use_note_input);
    test.privacy.apply_actions(:actions);

    // The note was spent. Nullifier is tied to user_2.private_key.
    let nullifier = user_2.compute_nullifier(sender: user_1, token_addr: token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(:nullifier));

    // Key observation: if user_1 had instead opened a subchannel to user_2
    // using a FAKE public key pk_fake (not user_2's registered key), and
    // created a note in that subchannel, a party knowing the fake private key
    // could spend it (while user_2 could not). The missing registered-key
    // check means the spending is not tied to the on-chain identity binding.
    //
    // This test shows normal spending succeeds; the design gap is that
    // the contract does not enforce: owner_private_key -> derived_pk == registered_pk[owner_addr].
}
```

**How to verify:**
```
cd packages/privacy && snforge test test_use_note_does_not_verify_registered_public_key
```

---

## Summary

| # | Issue | Severity | Real Bug? |
|---|-------|----------|-----------|
| 1 | Double-spend via cross-tx (WriteOnce mechanism) | — | No — defence is sound |
| 2 | Missing `channel_key != 0` check in `UseNoteInput::assert_valid` | Low | Yes — documented invariant violated, no early rejection |
| 3 | No `derive_public_key(owner_private_key) == registered_pk` check | Informational | Design gap, not exploitable in current protocol |

### Recommended Fixes

**Bug 2** — Add to `UseNoteInputValid::assert_valid` in `packages/privacy/src/actions.cairo`:
```cairo
pub(crate) impl UseNoteInputValid of InputValidation<UseNoteInput> {
    fn assert_valid(self: UseNoteInput) {
        let UseNoteInput { channel_key, token, index: _ } = self;
        assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY); // NEW
        assert(token.is_non_zero(), errors::ZERO_TOKEN);
    }
}
```

**Bug 3** — Add registered-key check in `use_note` in `packages/privacy/src/privacy.cairo` (after computing `owner_public_key`):
```cairo
let owner_public_key = derive_public_key(private_key: owner_private_key);
// Add: verify the private key matches the registered identity.
let registered_public_key = self.public_key.read(owner_addr);
assert(registered_public_key.is_non_zero(), errors::OWNER_NOT_REGISTERED);
assert(owner_public_key == registered_public_key, errors::OWNER_NOT_AUTHENTICATED);
```
