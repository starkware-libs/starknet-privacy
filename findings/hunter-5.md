# Hunter 5 Findings — Phase Ordering & Replay Protection

## Scope

Investigation of `packages/privacy/src/actions.cairo` and `packages/privacy/src/privacy.cairo`,
focusing on:

- Phase ordering enforcement (`assert_and_advance_phase`)
- Replay protection (`has_replay_protection` / `NO_REPLAY_PROTECTION`)
- Input validation gaps in `UseNoteInput` and `OpenSubchannelInput`

---

## Triage of All Six Prompts

All six scenarios from the brief were already covered by existing tests:

| Scenario | Where Caught | Existing Test |
|---|---|---|
| 1. Deposit+Withdraw only | `has_replay_protection = false` → `NO_REPLAY_PROTECTION` | `test_no_replay_protection` |
| 2. Empty client_actions | `has_replay_protection = false` → `NO_REPLAY_PROTECTION` | `test_no_replay_protection`, `test_compile_and_panic_assertions` |
| 3. InvokeExternal only | `has_replay_protection = false` → `NO_REPLAY_PROTECTION` | `test_no_replay_protection` |
| 4. Multiple Deposits | Allowed by phase logic; `FINAL_BALANCE_MUST_BE_ZERO` if not balanced | `test_compile_and_panic_balance_assertions` |
| 5. InvokeExternal → Withdraw | `curr_phase = 8` after invoke; next action phase 6 < 8 → `ACTIONS_OUT_OF_ORDER` | `test_actions_out_of_order` (line 5067) |
| 6. UseNoteInput.channel_key = 0 | Fails with `SUBCHANNEL_NOT_FOUND` (subchannel_marker lookup returns false) | **NOT TESTED** — see Finding 1 |

---

## Finding 1 (Code Quality / Defense-in-Depth): `UseNoteInput::assert_valid` Does Not Reject Zero `channel_key`

**File:** `packages/privacy/src/actions.cairo`, lines 175–179

**Description:**

`UseNoteInput::assert_valid` only validates `token.is_non_zero()`. The `channel_key` field is
explicitly discarded (`channel_key: _`) and never asserted non-zero:

```cairo
pub(crate) impl UseNoteInputValid of InputValidation<UseNoteInput> {
    fn assert_valid(self: UseNoteInput) {
        let UseNoteInput { channel_key: _, token, index: _ } = self;
        assert(token.is_non_zero(), errors::ZERO_TOKEN);
    }
}
```

When a caller submits `UseNoteInput { channel_key: 0, token: some_valid_token, index: 0 }`, the code:

1. Passes `assert_valid()` — the zero channel_key is silently accepted.
2. Computes `subchannel_marker = hash(SUBCHANNEL_MARKER_TAG, 0, owner_addr, owner_pubkey, token)`.
3. Reads `subchannel_exists[subchannel_marker]` → `false`.
4. Fails with `SUBCHANNEL_NOT_FOUND`.

The caller receives `SUBCHANNEL_NOT_FOUND` as the error, which is misleading — the real problem
is a zero `channel_key`, not an absent subchannel. Contrast with `OpenChannelInput` and
`OpenSubchannelInput` which also silently skip `channel_key` validation.

**Consistency gap:** Every other input that accepts a `channel_key` parameter ignores it in
`assert_valid` as well (see `OpenSubchannelInput`, line 70–77). However, the assumption written
in the `use_note` doc comment is "Assumes owner_addr is non-zero and owner_private_key is non-zero
and canonical (checked in main)" — there is no corresponding documentation that `channel_key` is
expected non-zero, yet all the hash functions that consume it (`compute_subchannel_marker`,
`compute_note_id`, `compute_nullifier`) carry the comment "Assumes all the inputs are not zero."

**Impact:** No security vulnerability — the zero channel_key path fails safely at
`SUBCHANNEL_NOT_FOUND`. However:

- The error is misleading for debugging.
- The hash invariant ("assumes channel_key is non-zero") is silently broken at the API boundary.
- No existing test covers `UseNoteInput { channel_key: 0 }`.

**Severity:** Low (code quality / missing validation)

**Test demonstrating the behavior:**

```cairo
/// Demonstrates that UseNoteInput with channel_key=0 passes assert_valid() but fails
/// later at SUBCHANNEL_NOT_FOUND rather than at a dedicated ZERO_CHANNEL_KEY error.
/// This is a missing defensive assertion: the hash functions assume channel_key is non-zero
/// but assert_valid does not enforce it.
#[test]
fn test_use_note_zero_channel_key_reaches_subchannel_not_found() {
    use core::num::traits::Zero;
    use privacy::actions::UseNoteInput;
    use privacy::{errors};
    use privacy::tests::utils_for_tests::{Test, TestTrait, UserTrait};
    use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_addr = test.mock_new_token();

    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    // channel_key = 0: passes assert_valid (only token is checked), fails at
    // SUBCHANNEL_NOT_FOUND because hash(SUBCHANNEL_MARKER_TAG, 0, ...) maps to an
    // unset storage slot.
    let zero_channel_key_input = UseNoteInput {
        channel_key: Zero::zero(), token: token_addr, index: 0,
    };
    let result = user.safe_use_note(note: zero_channel_key_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    let result = user.safe_use_note_compile_and_panic(note: zero_channel_key_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);

    let result = user.safe_use_note_compile_actions(note: zero_channel_key_input);
    assert_panic_with_felt_error(:result, expected_error: errors::SUBCHANNEL_NOT_FOUND);
}
```

---

## Finding 2 (Code Quality / Defense-in-Depth): `OpenSubchannelInput::assert_valid` Also Skips `channel_key`

**File:** `packages/privacy/src/actions.cairo`, lines 68–78

**Description:**

Same gap as Finding 1. `OpenSubchannelInput::assert_valid` explicitly discards `channel_key`
(`channel_key: _`) and performs no non-zero check:

```cairo
pub(crate) impl OpenSubchannelInputValid of InputValidation<OpenSubchannelInput> {
    fn assert_valid(self: OpenSubchannelInput) {
        let OpenSubchannelInput {
            recipient_addr, recipient_public_key, channel_key: _, index: _, token, salt,
        } = self;
        assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
        assert(recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
        assert(token.is_non_zero(), errors::ZERO_TOKEN);
        assert(salt.is_non_zero(), errors::ZERO_SALT);
    }
}
```

With `channel_key = 0`:
1. Passes `assert_valid()`.
2. Computes `channel_marker = hash(CHANNEL_MARKER_TAG, 0, sender_addr, recipient_addr, recipient_public_key)`.
3. Reads `channel_exists[channel_marker]` → `false`.
4. Fails with `INVALID_CHANNEL`.

The existing tests for `open_subchannel` do test wrong (non-zero) channel keys (`channel_key + 1`)
but never `channel_key = 0`. The error at that path is `INVALID_CHANNEL`, which is misleading since
no channel ever was created with the zero channel key.

**Test demonstrating the behavior:**

```cairo
/// Demonstrates that OpenSubchannelInput with channel_key=0 passes assert_valid() but fails
/// later at INVALID_CHANNEL rather than a dedicated ZERO_CHANNEL_KEY error.
#[test]
fn test_open_subchannel_zero_channel_key_reaches_invalid_channel() {
    use core::num::traits::Zero;
    use privacy::{errors};
    use privacy::tests::utils_for_tests::{Test, TestTrait, UserTrait};
    use starkware_utils_testing::test_utils::assert_panic_with_felt_error;

    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_addr = test.mock_new_token();
    let salt = user_1.get_salt().into();
    let index = 0;

    user_1.set_viewing_key_e2e();
    user_2.set_viewing_key_e2e();
    user_1.open_channel_e2e(recipient: user_2, index: 0);

    // channel_key = 0: passes assert_valid, fails at INVALID_CHANNEL because
    // hash(CHANNEL_MARKER_TAG, 0, ...) maps to an unset slot.
    let result = user_1
        .safe_open_subchannel_with_channel_key(
            recipient: user_2, :token_addr, :index, :salt, channel_key: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    let result = user_1
        .safe_open_subchannel_with_channel_key_compile_and_panic(
            recipient: user_2, :token_addr, :index, :salt, channel_key: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);

    let result = user_1
        .safe_open_subchannel_with_channel_key_compile_actions(
            recipient: user_2, :token_addr, :index, :salt, channel_key: Zero::zero(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::INVALID_CHANNEL);
}
```

---

## Summary

| # | Title | Severity | Real Bug? | Existing Test? |
|---|-------|----------|-----------|----------------|
| 1 | `UseNoteInput::assert_valid` does not reject `channel_key = 0` | Low | Code quality / missing validation | No |
| 2 | `OpenSubchannelInput::assert_valid` does not reject `channel_key = 0` | Low | Code quality / missing validation | No |
| 3–8 | All six scenarios from the investigation brief | N/A | All already caught correctly | Yes |

**Net security finding count: 0.** The replay protection and phase ordering machinery is
correct and comprehensively tested. The only gaps are missing defensive early-exit assertions
for zero `channel_key` inputs, which result in misleading error messages rather than any
exploitable vulnerability.

**Fix suggestion:** Add `assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY)` to both
`UseNoteInputValid` and `OpenSubchannelInputValid`, and add `ZERO_CHANNEL_KEY: felt252 = 'ZERO_CHANNEL_KEY'`
to `errors.cairo`. Add corresponding test cases to `test_transfer_assertions` and
`test_open_subchannel_assertions`.
