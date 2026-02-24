//! End-to-end tests for `execute_actions_e2e`.
//! These tests execute real client flows and verify contract state with views.

use core::num::traits::Zero;
use ekubo::interfaces::router::TokenAmount;
use ekubo::types::i129::i129;
use privacy::actions::{
    ClientAction, CreateEncNoteInput, DepositInput, InvokeExternalInput, OpenChannelInput,
    OpenSubchannelInput, SetViewingKeyInput, UseNoteInput, WithdrawInput,
};
use privacy::objects::OpenNoteDeposit;
use privacy::tests::utils_for_tests::{
    PrivacyCfgTrait, Test, TestTrait, User, UserTrait, VesuTrait, build_ekubo_swap_helper_calldata,
    pool_key_for_tokens,
};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::{encrypt_channel_info, unpack};
use snforge_std::TokenTrait;
use starknet::ContractAddress;
use starkware_utils_testing::test_utils::TokenHelperTrait;

// Helper: Constants for e2e testing.
const RANDOM: felt252 = 0x24a7f3e2b1c9d8e6f5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e;
const SALT: felt252 = 0x7f8e9d0c1b2a3948576e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b;
const SALT_120: u128 = 0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c;

/// Helper: Run a tx for registering a user.
fn register_user_tx(ref test: Test, user: User) {
    test.privacy.execute_actions_e2e(:user, client_actions: [set_viewing_key_action()].span());
}

/// Helper: SetViewingKey action.
fn set_viewing_key_action() -> ClientAction {
    ClientAction::SetViewingKey(SetViewingKeyInput { random: RANDOM })
}

/// Helper: OpenChannel action.
fn open_channel_action(from: User, to: User, index: usize) -> ClientAction {
    ClientAction::OpenChannel(
        OpenChannelInput { recipient_addr: to.address, index, random: RANDOM, salt: SALT },
    )
}

/// Helper: OpenSubchannel action.
fn open_subchannel_action(
    from: User, to: User, token_addr: ContractAddress, index: usize,
) -> ClientAction {
    ClientAction::OpenSubchannel(
        OpenSubchannelInput {
            recipient_addr: to.address,
            recipient_public_key: to.public_key,
            channel_key: from.compute_channel_key(recipient: to),
            index,
            token: token_addr,
            salt: SALT,
        },
    )
}

/// Helper: Deposit action.
fn deposit_action(token_addr: ContractAddress, amount: u128) -> ClientAction {
    ClientAction::Deposit(DepositInput { token: token_addr, amount })
}

/// Helper: Withdraw action.
fn withdraw_action(
    to_addr: ContractAddress, token_addr: ContractAddress, amount: u128,
) -> ClientAction {
    ClientAction::Withdraw(WithdrawInput { to_addr, token: token_addr, amount, random: RANDOM })
}

/// Helper: UseNote action.
fn use_note_action(
    channel_key: felt252, token_addr: ContractAddress, index: usize,
) -> ClientAction {
    ClientAction::UseNote(UseNoteInput { channel_key, token: token_addr, index })
}

/// Helper: CreateEncNote input.
fn create_enc_note_input(
    to: User, token: ContractAddress, amount: u128, index: usize,
) -> CreateEncNoteInput {
    CreateEncNoteInput {
        recipient_addr: to.address,
        recipient_public_key: to.public_key,
        token,
        amount,
        index,
        salt: SALT_120,
    }
}

/// Runs one full e2e flow step by step.
#[test]
fn test_e2e_client_actions_one_by_one() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let out_token = test.new_token();
    let out_token_addr = out_token.contract_address();
    let amount_total = 100_u128;
    let amount_half = amount_total / 2;

    user_1.increase_token_balance(:token, amount: amount_total);
    user_1.approve(:token, amount: amount_total.into());

    // 1. SetViewingKey (user_1)
    register_user_tx(ref test, user_1);
    assert_eq!(user_1.get_public_key(), user_1.public_key);
    assert_eq!(user_1.get_enc_private_key(), user_1.compute_enc_private_key(RANDOM));

    // 2. SetViewingKey (user_2)
    register_user_tx(ref test, user_2);
    assert_eq!(user_2.get_public_key(), user_2.public_key);
    assert_eq!(user_2.get_enc_private_key(), user_2.compute_enc_private_key(RANDOM));

    // 3. OpenChannel (user_1 -> user_2)
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [open_channel_action(from: user_1, to: user_2, index: 0),].span(),
        );
    let channel_marker = user_1.compute_channel_marker(recipient: user_2);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    assert!(test.privacy.channel_exists(:channel_marker));
    assert_eq!(user_2.get_num_of_channels(), 1);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: RANDOM,
        recipient_public_key: user_2.public_key,
        :channel_key,
        sender_addr: user_1.address,
    );
    assert_eq!(user_2.get_channel_info(channel_index: 0), expected_enc_channel_info);

    // 4. OpenSubchannel (user_1 -> user_2, token)
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_subchannel_action(from: user_1, to: user_2, :token_addr, index: 0),
            ]
                .span(),
        );
    let subchannel_marker = user_1.compute_subchannel_marker(recipient: user_2, :token_addr);
    assert!(test.privacy.subchannel_exists(:subchannel_marker));
    let subchannel_id = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_addr, index: 0, salt: SALT);
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_id), expected_enc_subchannel_info);

    // 4b. OpenSubchannel (user_1 -> user_2, out_token) for CreateOpenNote + InvokeExternal later
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_subchannel_action(
                    from: user_1, to: user_2, token_addr: out_token_addr, index: 1,
                ),
            ]
                .span(),
        );

    // 5. Deposit + CreateEncNote + CreateEncNote (user_1: deposit 100, create two notes of 50 each;
    // one tx so final balance is zero)
    let create_note_0 = create_enc_note_input(
        to: user_2, token: token_addr, amount: amount_half, index: 0,
    );
    let create_note_1 = create_enc_note_input(
        to: user_2, token: token_addr, amount: amount_half, index: 1,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                deposit_action(token_addr, amount_total),
                ClientAction::CreateEncNote(create_note_0),
                ClientAction::CreateEncNote(create_note_1),
            ]
                .span(),
        );
    assert_eq!(token.balance_of(address: test.privacy.address), amount_total.into());
    assert_eq!(token.balance_of(address: user_1.address), Zero::zero());
    let (note_id_0, expected_note_0) = user_1.compute_enc_note(create_note_input: create_note_0);
    let (note_id_1, expected_note_1) = user_1.compute_enc_note(create_note_input: create_note_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), expected_note_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_1), expected_note_1);

    // 7. UseNote + Withdraw half (user_2: spend note 0, withdraw to user_1)
    test
        .privacy
        .execute_actions_e2e(
            user: user_2,
            client_actions: [
                use_note_action(channel_key, token_addr, 0),
                withdraw_action(user_1.address, token_addr, amount_half),
            ]
                .span(),
        );
    let nullifier_0 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    assert_eq!(token.balance_of(address: user_1.address), amount_half.into());
    assert_eq!(token.balance_of(address: test.privacy.address), amount_half.into());

    // 8. CreateOpenNote + InvokeExternal(echo) (user_1: open note for user_2, deposited to via
    // echo executor in the same tx)
    let create_open_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2, token_addr: out_token_addr, index: 0,
        );
    let (open_note_id, _) = user_1.compute_open_note(create_note_input: create_open_note_input);

    // Fund the depositor (echo_executor) with out_token and approve.
    out_token.supply(address: test.privacy.echo_executor, amount: amount_half);
    out_token
        .approve(
            owner: test.privacy.echo_executor,
            spender: test.privacy.address,
            amount: amount_half.into(),
        );

    let echo_invoke = test
        .privacy
        .invoke_external_echo_deposits(
            [OpenNoteDeposit { note_id: open_note_id, token: out_token_addr, amount: amount_half },]
                .span(),
        );
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                ClientAction::CreateOpenNote(create_open_note_input),
                ClientAction::InvokeExternal(echo_invoke),
            ]
                .span(),
        );
    let note_after_deposit = test.privacy.get_note(note_id: open_note_id);
    assert_eq!(note_after_deposit.token, out_token_addr);
    let (salt, stored_amount) = unpack(packed_value: note_after_deposit.packed_value);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(stored_amount, amount_half);
    assert_eq!(out_token.balance_of(address: test.privacy.address), amount_half.into());
    assert_eq!(out_token.balance_of(address: test.privacy.echo_executor), Zero::zero());
    assert_eq!(out_token.balance_of(address: test.privacy.mock_amm), Zero::zero())
    assert_eq!(token.balance_of(address: test.privacy.address), amount_half.into());
    assert_eq!(token.balance_of(address: test.privacy.echo_executor), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.mock_amm), Zero::zero());

    // 9. UseNote + Withdraw half (user_2: spend note 1, withdraw to user_1)
    test
        .privacy
        .execute_actions_e2e(
            user: user_2,
            client_actions: [
                use_note_action(channel_key, token_addr, 1),
                withdraw_action(user_1.address, token_addr, amount_half),
            ]
                .span(),
        );
    let nullifier_1 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1));
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token.balance_of(address: user_1.address), amount_total.into());
}

/// Runs all executable action phases in one correctly ordered e2e tx.
#[test]
fn test_e2e_action_phases_in_correct_order() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let in_token = test.new_token();
    let out_token = test.new_token();
    let in_token_addr = in_token.contract_address();
    let out_token_addr = out_token.contract_address();
    let amount_a = 60_u128;
    let amount_b = 140_u128;
    let total_amount = amount_a + amount_b;
    let swap_executor_addr = test.privacy.swap_executor.address;

    user_1.increase_token_balance(token: in_token, amount: total_amount);
    user_1.approve(token: in_token, amount: total_amount.into());

    // Tx 1-2: register both users.
    register_user_tx(ref test, user_1);
    register_user_tx(ref test, user_2);

    let channel_key_self = user_1.compute_channel_key(recipient: user_1);
    let create_self_note_0 = create_enc_note_input(
        to: user_1, token: in_token_addr, amount: amount_a, index: 0,
    );

    // Tx 3: create one spendable self note for the later combined transaction.
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_channel_action(from: user_1, to: user_1, index: 0),
                open_subchannel_action(
                    from: user_1, to: user_1, token_addr: in_token_addr, index: 0,
                ),
                deposit_action(token_addr: in_token_addr, amount: amount_a),
                ClientAction::CreateEncNote(create_self_note_0),
            ]
                .span(),
        );

    let create_note_for_user_2 = create_enc_note_input(
        to: user_2, token: in_token_addr, amount: amount_a, index: 0,
    );
    let create_open_note = user_1
        .new_open_note_with_generated_random(
            recipient: user_1, token_addr: out_token_addr, index: 0,
        );
    let (open_note_id, _) = user_1.compute_open_note(create_note_input: create_open_note);
    let invoke_input = user_1
        .invoke_external_mock_swap_executor_input(
            in_token: in_token_addr,
            out_token: out_token_addr,
            amount: amount_b,
            note_id: open_note_id,
        );

    out_token.supply(address: test.privacy.mock_amm, amount: amount_b);

    // Tx 4: run the ordered phases together after the one-time registration setup.
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_channel_action(from: user_1, to: user_2, index: 1),
                open_subchannel_action(
                    from: user_1, to: user_2, token_addr: in_token_addr, index: 0,
                ),
                open_subchannel_action(
                    from: user_1, to: user_1, token_addr: out_token_addr, index: 1,
                ),
                deposit_action(token_addr: in_token_addr, amount: amount_b),
                use_note_action(channel_key: channel_key_self, token_addr: in_token_addr, index: 0),
                ClientAction::CreateEncNote(create_note_for_user_2),
                ClientAction::CreateOpenNote(create_open_note),
                withdraw_action(
                    to_addr: swap_executor_addr, token_addr: in_token_addr, amount: amount_b,
                ),
                ClientAction::InvokeExternal(invoke_input),
            ]
                .span(),
        );

    let channel_marker_1_2 = user_1.compute_channel_marker(recipient: user_2);
    let nullifier_self_0 = user_1
        .compute_nullifier(sender: user_1, token_addr: in_token_addr, index: 0);
    let (note_id_1_2_0, note_1_2_0) = user_1
        .compute_enc_note(create_note_input: create_note_for_user_2);
    let note_after_swap = test.privacy.get_note(note_id: open_note_id);
    let (salt, filled_amount) = unpack(packed_value: note_after_swap.packed_value);

    assert!(test.privacy.channel_exists(channel_marker: channel_marker_1_2));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_self_0));
    assert_eq!(test.privacy.get_note(note_id: note_id_1_2_0), note_1_2_0);
    assert_eq!(note_after_swap.token, out_token_addr);
    assert_eq!(salt, OPEN_NOTE_SALT);
    assert_eq!(filled_amount, amount_b);
    assert_eq!(in_token.balance_of(address: user_1.address), Zero::zero());
    assert_eq!(in_token.balance_of(address: test.privacy.address), amount_a.into());
    assert_eq!(in_token.balance_of(address: test.privacy.mock_amm), amount_b.into());
    assert_eq!(in_token.balance_of(address: swap_executor_addr), Zero::zero());
    assert_eq!(out_token.balance_of(address: user_1.address), Zero::zero());
    assert_eq!(out_token.balance_of(address: test.privacy.address), amount_b.into());
    assert_eq!(out_token.balance_of(address: test.privacy.mock_amm), Zero::zero());
    assert_eq!(out_token.balance_of(address: swap_executor_addr), Zero::zero());
}

/// Deposits and creates a note for another user.
#[test]
fn test_e2e_deposit_create_note_for_other_user() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100_u128;
    user_1.increase_token_balance(:token, :amount);
    user_1.approve(:token, amount: amount.into());

    // Tx 1+2: register both users.
    register_user_tx(ref test, user_1);
    register_user_tx(ref test, user_2);

    // Tx 3: open channel + subchannel from user_1 to user_2, then deposit and create note for
    // user_2 in the same transaction.
    let create_note = create_enc_note_input(to: user_2, token: token_addr, :amount, index: 0);
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_channel_action(from: user_1, to: user_2, index: 0),
                open_subchannel_action(from: user_1, to: user_2, :token_addr, index: 0),
                deposit_action(token_addr, amount), ClientAction::CreateEncNote(create_note),
            ]
                .span(),
        );

    let (note_id, expected_note) = user_1.compute_enc_note(create_note_input: create_note);
    assert_eq!(test.privacy.get_note(:note_id), expected_note);
    assert_eq!(token.balance_of(address: user_1.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

/// Recreates the same amount on the same self channel.
#[test]
fn test_e2e_transfer_same_channel_same_amount() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100_u128;
    user.increase_token_balance(:token, :amount);
    user.approve(:token, amount: amount.into());

    // Tx 1: register user.
    register_user_tx(ref test, user);

    let channel_key_self = user.compute_channel_key(recipient: user);

    // Tx 2: open self channel + subchannel, deposit, and create one note.
    let create_note_0 = create_enc_note_input(to: user, token: token_addr, :amount, index: 0);
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                open_channel_action(from: user, to: user, index: 0),
                open_subchannel_action(from: user, to: user, :token_addr, index: 0),
                deposit_action(token_addr, amount), ClientAction::CreateEncNote(create_note_0),
            ]
                .span(),
        );
    let (note_id_0, note_0) = user.compute_enc_note(create_note_input: create_note_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());

    // Tx 3: use the note and recreate the same amount on the same channel.
    let create_note_1 = create_enc_note_input(to: user, token: token_addr, :amount, index: 1);
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                use_note_action(channel_key_self, token_addr, 0),
                ClientAction::CreateEncNote(create_note_1),
            ]
                .span(),
        );

    let nullifier_0 = user.compute_nullifier(sender: user, :token_addr, index: 0);
    let (note_id_1, note_1) = user.compute_enc_note(create_note_input: create_note_1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), note_1);
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
}

/// Merges notes from multiple channels into one self note.
#[test]
fn test_e2e_merge_notes_from_multiple_channels() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let mut user_3 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount_1a = 40_u128;
    let amount_1b = 60_u128;
    let amount_3 = 50_u128;
    let total_amount = amount_1a + amount_1b + amount_3;
    user_1.increase_token_balance(:token, amount: amount_1a + amount_1b);
    user_1.approve(:token, amount: (amount_1a + amount_1b).into());
    user_3.increase_token_balance(:token, amount: amount_3);
    user_3.approve(:token, amount: amount_3.into());

    // Tx 1-3: register all users.
    register_user_tx(ref test, user_1);
    register_user_tx(ref test, user_2);
    register_user_tx(ref test, user_3);

    let channel_key_1_2 = user_1.compute_channel_key(recipient: user_2);
    let channel_key_3_2 = user_3.compute_channel_key(recipient: user_2);

    // Tx 4: user_1 creates two notes for user_2 on the same channel.
    let create_1_0 = create_enc_note_input(
        to: user_2, token: token_addr, amount: amount_1a, index: 0,
    );
    let create_1_1 = create_enc_note_input(
        to: user_2, token: token_addr, amount: amount_1b, index: 1,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_channel_action(from: user_1, to: user_2, index: 0),
                open_subchannel_action(from: user_1, to: user_2, :token_addr, index: 0),
                deposit_action(token_addr, amount_1a + amount_1b),
                ClientAction::CreateEncNote(create_1_0), ClientAction::CreateEncNote(create_1_1),
            ]
                .span(),
        );
    let (note_id_1_0, note_1_0) = user_1.compute_enc_note(create_note_input: create_1_0);
    let (note_id_1_1, note_1_1) = user_1.compute_enc_note(create_note_input: create_1_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_1_0), note_1_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_1_1), note_1_1);

    // Tx 5: user_3 creates one note for user_2 on a different channel.
    let create_3_0 = create_enc_note_input(
        to: user_2, token: token_addr, amount: amount_3, index: 0,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_3,
            client_actions: [
                open_channel_action(from: user_3, to: user_2, index: 0),
                open_subchannel_action(from: user_3, to: user_2, :token_addr, index: 0),
                deposit_action(token_addr, amount_3), ClientAction::CreateEncNote(create_3_0),
            ]
                .span(),
        );
    let (note_id_3_0, note_3_0) = user_3.compute_enc_note(create_note_input: create_3_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_3_0), note_3_0);
    assert_eq!(token.balance_of(address: test.privacy.address), total_amount.into());

    // Tx 6: user_2 merges all three notes into one self note.
    let create_merged = create_enc_note_input(
        to: user_2, token: token_addr, amount: total_amount, index: 0,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_2,
            client_actions: [
                open_channel_action(from: user_2, to: user_2, index: 0),
                open_subchannel_action(from: user_2, to: user_2, :token_addr, index: 0),
                use_note_action(channel_key_1_2, token_addr, 0),
                use_note_action(channel_key_1_2, token_addr, 1),
                use_note_action(channel_key_3_2, token_addr, 0),
                ClientAction::CreateEncNote(create_merged),
            ]
                .span(),
        );

    let nullifier_1_0 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    let nullifier_1_1 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 1);
    let nullifier_3_0 = user_2.compute_nullifier(sender: user_3, :token_addr, index: 0);
    let (merged_note_id, merged_note) = user_2.compute_enc_note(create_note_input: create_merged);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1_0));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1_1));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_3_0));
    assert_eq!(test.privacy.get_note(note_id: merged_note_id), merged_note);
    assert_eq!(token.balance_of(address: user_1.address), Zero::zero());
    assert_eq!(token.balance_of(address: user_2.address), Zero::zero());
    assert_eq!(token.balance_of(address: user_3.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), total_amount.into());
}

/// Splits one note into two notes for self.
#[test]
fn test_e2e_split_one_note_into_two_self_notes() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount_total = 100_u128;
    let amount_1 = 40_u128;
    let amount_2 = amount_total - amount_1;
    user.increase_token_balance(:token, amount: amount_total);
    user.approve(:token, amount: amount_total.into());

    // Tx 1: register user.
    register_user_tx(ref test, user);

    let channel_key_self = user.compute_channel_key(recipient: user);

    // Tx 2: open self channel + subchannel, deposit, and create one note.
    let create_note_0 = create_enc_note_input(
        to: user, token: token_addr, amount: amount_total, index: 0,
    );
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                open_channel_action(from: user, to: user, index: 0),
                open_subchannel_action(from: user, to: user, :token_addr, index: 0),
                deposit_action(token_addr, amount_total),
                ClientAction::CreateEncNote(create_note_0),
            ]
                .span(),
        );
    let (note_id_0, note_0) = user.compute_enc_note(create_note_input: create_note_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount_total.into());

    // Tx 3: use the note and create two new notes for self.
    let create_note_1 = create_enc_note_input(
        to: user, token: token_addr, amount: amount_1, index: 1,
    );
    let create_note_2 = create_enc_note_input(
        to: user, token: token_addr, amount: amount_2, index: 2,
    );
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                use_note_action(channel_key_self, token_addr, 0),
                ClientAction::CreateEncNote(create_note_1),
                ClientAction::CreateEncNote(create_note_2),
            ]
                .span(),
        );

    let nullifier_0 = user.compute_nullifier(sender: user, :token_addr, index: 0);
    let (note_id_1, note_1) = user.compute_enc_note(create_note_input: create_note_1);
    let (note_id_2, note_2) = user.compute_enc_note(create_note_input: create_note_2);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    assert_eq!(test.privacy.get_note(note_id: note_id_1), note_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_2), note_2);
    assert_eq!(token.balance_of(address: user.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount_total.into());
}

/// Deposits notes to self and withdraws them.
#[test]
fn test_e2e_deposit_withdraw_flow() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100_u128;
    user.increase_token_balance(:token, amount: 2 * amount);
    user.approve(:token, amount: (2 * amount).into());

    // Tx 1: SetViewingKey, OpenChannel(self), OpenSubchannel, Deposit, CreateEncNote (to self)
    let channel_key_self = user.compute_channel_key(recipient: user);
    let create_note_0 = create_enc_note_input(to: user, token: token_addr, :amount, index: 0);
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                set_viewing_key_action(), open_channel_action(from: user, to: user, index: 0),
                open_subchannel_action(from: user, to: user, :token_addr, index: 0),
                deposit_action(token_addr, amount), ClientAction::CreateEncNote(create_note_0),
            ]
                .span(),
        );
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
    let (note_id_0, note_0) = user.compute_enc_note(create_note_input: create_note_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);

    // Tx 2: Deposit + CreateEncNote (to self, index 1)
    let create_note_1 = create_enc_note_input(to: user, token: token_addr, :amount, index: 1);
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                deposit_action(token_addr, amount), ClientAction::CreateEncNote(create_note_1),
            ]
                .span(),
        );
    assert_eq!(token.balance_of(address: test.privacy.address), (2 * amount).into());
    let (note_id_1, note_1) = user.compute_enc_note(create_note_input: create_note_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_1), note_1);

    // Tx 3: Use both notes + Withdraw
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                use_note_action(channel_key_self, token_addr, 0),
                use_note_action(channel_key_self, token_addr, 1),
                withdraw_action(user.address, token_addr, 2 * amount),
            ]
                .span(),
        );
    let nullifier_0 = user.compute_nullifier(sender: user, :token_addr, index: 0);
    let nullifier_1 = user.compute_nullifier(sender: user, :token_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1));
    assert_eq!(token.balance_of(address: user.address), (2 * amount).into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
}

/// Splits one note across two users and self.
#[test]
fn test_e2e_deposit_split_with_leftover_and_all_withdraw() {
    let mut test: Test = Default::default();
    let mut user_a = test.new_user();
    let mut user_b = test.new_user();
    let mut user_c = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount_total = 100_u128;
    let amount_b = 30_u128;
    let amount_c = 20_u128;
    let amount_self = amount_total - amount_b - amount_c;
    user_a.increase_token_balance(:token, amount: amount_total);
    user_a.approve(:token, amount: amount_total.into());

    // Tx 1-3: register all users.
    register_user_tx(ref test, user_a);
    register_user_tx(ref test, user_b);
    register_user_tx(ref test, user_c);

    let channel_key_self = user_a.compute_channel_key(recipient: user_a);
    let channel_key_a_b = user_a.compute_channel_key(recipient: user_b);
    let channel_key_a_c = user_a.compute_channel_key(recipient: user_c);

    // Tx 4: open self channel+subchannel and deposit one note for user A.
    let create_self_0 = create_enc_note_input(
        to: user_a, token: token_addr, amount: amount_total, index: 0,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_a,
            client_actions: [
                open_channel_action(from: user_a, to: user_a, index: 0),
                open_subchannel_action(from: user_a, to: user_a, :token_addr, index: 0),
                deposit_action(token_addr, amount_total),
                ClientAction::CreateEncNote(create_self_0),
            ]
                .span(),
        );
    let (self_note_id_0, self_note_0) = user_a.compute_enc_note(create_note_input: create_self_0);
    assert_eq!(test.privacy.get_note(note_id: self_note_id_0), self_note_0);
    assert_eq!(token.balance_of(address: user_a.address), Zero::zero());
    assert_eq!(token.balance_of(address: test.privacy.address), amount_total.into());

    // Tx 5: split the deposited note into notes for B, C, and leftover for A.
    let create_for_b = create_enc_note_input(
        to: user_b, token: token_addr, amount: amount_b, index: 0,
    );
    let create_for_c = create_enc_note_input(
        to: user_c, token: token_addr, amount: amount_c, index: 0,
    );
    let create_self_1 = create_enc_note_input(
        to: user_a, token: token_addr, amount: amount_self, index: 1,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_a,
            client_actions: [
                open_channel_action(from: user_a, to: user_b, index: 1),
                open_channel_action(from: user_a, to: user_c, index: 2),
                open_subchannel_action(from: user_a, to: user_b, :token_addr, index: 0),
                open_subchannel_action(from: user_a, to: user_c, :token_addr, index: 0),
                use_note_action(channel_key_self, token_addr, 0),
                ClientAction::CreateEncNote(create_for_b),
                ClientAction::CreateEncNote(create_for_c),
                ClientAction::CreateEncNote(create_self_1),
            ]
                .span(),
        );
    let nullifier_self_0 = user_a.compute_nullifier(sender: user_a, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_self_0));
    let (note_id_b, note_b) = user_a.compute_enc_note(create_note_input: create_for_b);
    let (note_id_c, note_c) = user_a.compute_enc_note(create_note_input: create_for_c);
    let (note_id_self_1, note_self_1) = user_a.compute_enc_note(create_note_input: create_self_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_b), note_b);
    assert_eq!(test.privacy.get_note(note_id: note_id_c), note_c);
    assert_eq!(test.privacy.get_note(note_id: note_id_self_1), note_self_1);
    assert_eq!(token.balance_of(address: test.privacy.address), amount_total.into());

    // Tx 6: user B withdraws their note.
    test
        .privacy
        .execute_actions_e2e(
            user: user_b,
            client_actions: [
                use_note_action(channel_key_a_b, token_addr, 0),
                withdraw_action(user_b.address, token_addr, amount_b),
            ]
                .span(),
        );
    let nullifier_b = user_b.compute_nullifier(sender: user_a, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_b));
    assert_eq!(token.balance_of(address: user_b.address), amount_b.into());
    assert_eq!(token.balance_of(address: test.privacy.address), (amount_c + amount_self).into());

    // Tx 7: user C withdraws their note.
    test
        .privacy
        .execute_actions_e2e(
            user: user_c,
            client_actions: [
                use_note_action(channel_key_a_c, token_addr, 0),
                withdraw_action(user_c.address, token_addr, amount_c),
            ]
                .span(),
        );
    let nullifier_c = user_c.compute_nullifier(sender: user_a, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_c));
    assert_eq!(token.balance_of(address: user_c.address), amount_c.into());
    assert_eq!(token.balance_of(address: test.privacy.address), amount_self.into());

    // Tx 8: user A withdraws the leftover note.
    test
        .privacy
        .execute_actions_e2e(
            user: user_a,
            client_actions: [
                use_note_action(channel_key_self, token_addr, 1),
                withdraw_action(user_a.address, token_addr, amount_self),
            ]
                .span(),
        );
    let nullifier_self_1 = user_a.compute_nullifier(sender: user_a, :token_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_self_1));
    assert_eq!(token.balance_of(address: user_a.address), amount_self.into());
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
}

/// Transfers notes across users and merges at the end.
#[test]
fn test_e2e_transfer_flow() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token = test.new_token();
    let token_addr = token.contract_address();
    let amount = 100_u128;
    user_1.increase_token_balance(:token, amount: 3 * amount);
    user_1.approve(:token, amount: (3 * amount).into());

    let channel_key_self = user_1.compute_channel_key(recipient: user_1);

    // Tx 1: SetViewingKey, OpenChannel(self), OpenSubchannel, Deposit, CreateEncNote (to self,
    // index 0)
    let create_0 = create_enc_note_input(to: user_1, token: token_addr, :amount, index: 0);
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                set_viewing_key_action(), open_channel_action(from: user_1, to: user_1, index: 0),
                open_subchannel_action(from: user_1, to: user_1, :token_addr, index: 0),
                deposit_action(token_addr, amount), ClientAction::CreateEncNote(create_0),
            ]
                .span(),
        );

    // Tx 2: Deposit + CreateEncNote (to self, index 1)
    let create_1 = create_enc_note_input(to: user_1, token: token_addr, :amount, index: 1);
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                deposit_action(token_addr, amount), ClientAction::CreateEncNote(create_1),
            ]
                .span(),
        );

    // Tx 3: Deposit + CreateEncNote (to self, index 2)
    let create_2 = create_enc_note_input(to: user_1, token: token_addr, :amount, index: 2);
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                deposit_action(token_addr, amount), ClientAction::CreateEncNote(create_2),
            ]
                .span(),
        );

    // Tx 4: SetViewingKey (user_2)
    register_user_tx(ref test, user_2);

    // Tx 5: First transfer — OpenChannel(user_1->user_2) at outgoing index 1, OpenSubchannel, Use
    // 2 notes (0,1), CreateEncNote for user_2, CreateEncNote for self (surplus)
    let channel_key_1_2 = user_1.compute_channel_key(recipient: user_2);
    let amt_to_2 = 60_u128;
    let surplus = 2 * amount - amt_to_2; // 140
    let create_for_2_t1 = create_enc_note_input(
        to: user_2, token: token_addr, amount: amt_to_2, index: 0,
    );
    let create_self_3 = create_enc_note_input(
        to: user_1, token: token_addr, amount: surplus, index: 3,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_channel_action(from: user_1, to: user_2, index: 1),
                open_subchannel_action(from: user_1, to: user_2, :token_addr, index: 0),
                use_note_action(channel_key_self, token_addr, 0),
                use_note_action(channel_key_self, token_addr, 1),
                ClientAction::CreateEncNote(create_for_2_t1),
                ClientAction::CreateEncNote(create_self_3),
            ]
                .span(),
        );
    let nullifier_0 = user_1.compute_nullifier(sender: user_1, :token_addr, index: 0);
    let nullifier_1 = user_1.compute_nullifier(sender: user_1, :token_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1));
    let (note_id_0, note_0) = user_1.compute_enc_note(create_note_input: create_for_2_t1);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);
    let (note_id_3, note_3) = user_1.compute_enc_note(create_note_input: create_self_3);
    assert_eq!(test.privacy.get_note(note_id: note_id_3), note_3);

    // Tx 6: Second transfer — Use both notes (index 2 from deposit, index 3 from prev transfer),
    // Create 2 notes for user_2 and for self
    let amt_to_2_t2 = 100_u128;
    let surplus_2 = amount + surplus - amt_to_2_t2; // 100 + 140 - 100 = 140
    let create_for_2_t2 = create_enc_note_input(
        to: user_2, token: token_addr, amount: amt_to_2_t2, index: 1,
    );
    let create_self_4 = create_enc_note_input(
        to: user_1, token: token_addr, amount: surplus_2, index: 4,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                use_note_action(channel_key_self, token_addr, 2),
                use_note_action(channel_key_self, token_addr, 3),
                ClientAction::CreateEncNote(create_for_2_t2),
                ClientAction::CreateEncNote(create_self_4),
            ]
                .span(),
        );
    let nullifier_2 = user_1.compute_nullifier(sender: user_1, :token_addr, index: 2);
    let nullifier_3 = user_1.compute_nullifier(sender: user_1, :token_addr, index: 3);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_2));
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_3));
    let (note_id_1, note_1) = user_1.compute_enc_note(create_note_input: create_for_2_t2);
    assert_eq!(test.privacy.get_note(note_id: note_id_1), note_1);
    let (note_id_4, note_4) = user_1.compute_enc_note(create_note_input: create_self_4);
    assert_eq!(test.privacy.get_note(note_id: note_id_4), note_4);

    // Tx 7: Third transfer — Use note (index 4 from prev tx), Create for user_2
    let create_for_2_t3 = create_enc_note_input(
        to: user_2, token: token_addr, amount: surplus_2, index: 2,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                use_note_action(channel_key_self, token_addr, 4),
                ClientAction::CreateEncNote(create_for_2_t3),
            ]
                .span(),
        );
    let nullifier_4 = user_1.compute_nullifier(sender: user_1, :token_addr, index: 4);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_4));
    let (note_id_2, note_2) = user_1.compute_enc_note(create_note_input: create_for_2_t3);
    assert_eq!(test.privacy.get_note(note_id: note_id_2), note_2);

    // Tx 8: Self transfer — user_2 creates self channel, uses all 3 notes (from user_1->user_2),
    // creates single merged note to self (300)
    let create_merged = create_enc_note_input(
        to: user_2, token: token_addr, amount: 3 * amount, index: 0,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_2,
            client_actions: [
                open_channel_action(from: user_2, to: user_2, index: 0),
                open_subchannel_action(from: user_2, to: user_2, :token_addr, index: 0),
                use_note_action(channel_key_1_2, token_addr, 0),
                use_note_action(channel_key_1_2, token_addr, 1),
                use_note_action(channel_key_1_2, token_addr, 2),
                ClientAction::CreateEncNote(create_merged),
            ]
                .span(),
        );
    let (merged_note_id, merged_note) = user_2.compute_enc_note(create_note_input: create_merged);
    assert_eq!(test.privacy.get_note(note_id: merged_note_id), merged_note);
    let nullifier_0 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    let nullifier_1 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1));
    let nullifier_2 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 2);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_2));

    // Assert final state: user_2 has one merged note of 300; contract holds all 300 as backing
    assert_eq!(user_2.get_num_of_channels(), 2);
    assert_eq!(token.balance_of(address: test.privacy.address), (3 * amount).into());
}

/// Combines pairs of e2e actions in each tx.
#[test]
fn test_e2e_actions_twice() {
    let mut test: Test = Default::default();
    let mut user_1 = test.new_user();
    let mut user_2 = test.new_user();
    let token_1 = test.new_token();
    let token_2 = test.new_token();
    let token_1_addr = token_1.contract_address();
    let token_2_addr = token_2.contract_address();
    let amount = 100_u128;
    let half = amount / 2;
    let amount_u256: u256 = amount.into();
    user_1.increase_token_balance(token: token_1, :amount);
    user_1.increase_token_balance(token: token_2, :amount);
    user_1.approve(token: token_1, amount: amount_u256);
    user_1.approve(token: token_2, amount: amount_u256);

    // 1. user1 set viewing key
    register_user_tx(ref test, user_1);

    // 2. user2 set viewing key
    register_user_tx(ref test, user_2);

    let channel_key_self = user_1.compute_channel_key(recipient: user_1);

    // 3. user1: 2 open channels in one tx (self, user2)
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_channel_action(from: user_1, to: user_1, index: 0),
                open_channel_action(from: user_1, to: user_2, index: 1),
            ]
                .span(),
        );
    let channel_marker_self = user_1.compute_channel_marker(recipient: user_1);
    let channel_marker_1_2 = user_1.compute_channel_marker(recipient: user_2);
    assert!(test.privacy.channel_exists(channel_marker: channel_marker_self));
    assert!(test.privacy.channel_exists(channel_marker: channel_marker_1_2));

    // 4. user1: 2 open subchannels (self channel, 2 different tokens) in one tx
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                open_subchannel_action(
                    from: user_1, to: user_1, token_addr: token_1_addr, index: 0,
                ),
                open_subchannel_action(
                    from: user_1, to: user_1, token_addr: token_2_addr, index: 1,
                ),
            ]
                .span(),
        );
    let subchannel_marker_1 = user_1
        .compute_subchannel_marker(recipient: user_1, token_addr: token_1_addr);
    let subchannel_marker_2 = user_1
        .compute_subchannel_marker(recipient: user_1, token_addr: token_2_addr);
    assert!(test.privacy.subchannel_exists(subchannel_marker: subchannel_marker_1));
    assert!(test.privacy.subchannel_exists(subchannel_marker: subchannel_marker_2));

    // 5. user1: 2 deposit + 1 create enc note for token 1 (one tx; phase order: deposits then
    // create notes)
    let create_t1_0 = create_enc_note_input(to: user_1, token: token_1_addr, :amount, index: 0);
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                deposit_action(token_1_addr, half), deposit_action(token_1_addr, half),
                ClientAction::CreateEncNote(create_t1_0),
            ]
                .span(),
        );
    assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
    let (note_id_0, note_0) = user_1.compute_enc_note(create_note_input: create_t1_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);

    // 6. user1: 1 deposit + 2 create enc note for token 2 (one tx)
    let create_t2_0 = create_enc_note_input(
        to: user_1, token: token_2_addr, amount: half, index: 0,
    );
    let create_t2_1 = create_enc_note_input(
        to: user_1, token: token_2_addr, amount: half, index: 1,
    );
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                deposit_action(token_2_addr, amount), ClientAction::CreateEncNote(create_t2_0),
                ClientAction::CreateEncNote(create_t2_1),
            ]
                .span(),
        );
    assert_eq!(token_2.balance_of(address: test.privacy.address), amount.into());
    let (note_id_0, note_0) = user_1.compute_enc_note(create_note_input: create_t2_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);
    let (note_id_1, note_1) = user_1.compute_enc_note(create_note_input: create_t2_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_1), note_1);

    // 7. user1: 2 create open note (one tx)
    let create_open_note_1 = user_1
        .new_open_note_with_generated_random(recipient: user_1, token_addr: token_1_addr, index: 1);
    let create_open_note_2 = user_1
        .new_open_note_with_generated_random(recipient: user_1, token_addr: token_1_addr, index: 2);
    let (open_id_1, open_note_1) = user_1
        .compute_open_note_with_amount(create_note_input: create_open_note_1, amount: half);
    let (open_id_2, open_note_2) = user_1
        .compute_open_note_with_amount(create_note_input: create_open_note_2, amount: half);

    token_1.supply(address: test.privacy.echo_executor, :amount);
    token_1
        .approve(
            owner: test.privacy.echo_executor, spender: test.privacy.address, amount: amount.into(),
        );

    let echo_invoke = test
        .privacy
        .invoke_external_echo_deposits(
            [
                OpenNoteDeposit { note_id: open_id_1, token: token_1_addr, amount: half },
                OpenNoteDeposit { note_id: open_id_2, token: token_1_addr, amount: half },
            ]
                .span(),
        );
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                ClientAction::CreateOpenNote(create_open_note_1),
                ClientAction::CreateOpenNote(create_open_note_2),
                ClientAction::InvokeExternal(echo_invoke),
            ]
                .span(),
        );
    assert_eq!(test.privacy.get_note(note_id: open_id_1), open_note_1);
    assert_eq!(test.privacy.get_note(note_id: open_id_2), open_note_2);
    assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into() * 2);

    // 8. user1: use 1 note token 1 + 2 withdraws (one tx)
    let use_t1_0 = UseNoteInput { channel_key: channel_key_self, token: token_1_addr, index: 0 };
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                ClientAction::UseNote(use_t1_0),
                withdraw_action(user_1.address, token_1_addr, half),
                withdraw_action(user_1.address, token_1_addr, half),
            ]
                .span(),
        );
    assert_eq!(token_1.balance_of(address: user_1.address), amount.into());
    assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
    let nullifier_0 = user_1.compute_nullifier(sender: user_1, token_addr: token_1_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));

    // 9. user1: use both notes token 2 + 1 withdraw (one tx)
    test
        .privacy
        .execute_actions_e2e(
            user: user_1,
            client_actions: [
                use_note_action(channel_key_self, token_2_addr, 0),
                use_note_action(channel_key_self, token_2_addr, 1),
                withdraw_action(user_1.address, token_2_addr, amount),
            ]
                .span(),
        );
    assert_eq!(token_2.balance_of(address: user_1.address), amount.into());
    assert_eq!(token_2.balance_of(address: test.privacy.address), Zero::zero());
    let nullifier_0 = user_1.compute_nullifier(sender: user_1, token_addr: token_2_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    let nullifier_1 = user_1.compute_nullifier(sender: user_1, token_addr: token_2_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1));
}

/// Uses multiple actions and tokens in one tx.
#[test]
fn test_e2e_multi_action_multi_token_one_tx() {
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    let token_1 = test.new_token();
    let token_2 = test.new_token();
    let token_1_addr = token_1.contract_address();
    let token_2_addr = token_2.contract_address();
    let amount = 100_u128;
    let amount_u256: u256 = amount.into();
    user.increase_token_balance(token: token_1, :amount);
    user.increase_token_balance(token: token_2, :amount);
    user.approve(token: token_1, amount: amount_u256);
    user.approve(token: token_2, amount: amount_u256);

    let channel_key_self = user.compute_channel_key(recipient: user);

    // Tx1: SetViewingKey + OpenChannel + 2 OpenSubchannel + 2 Deposit + 2 CreateEncNote (one tx;
    // phase order: account, channel, subchannel, subchannel, deposit, deposit, create, create)
    let create_t1 = create_enc_note_input(to: user, token: token_1_addr, :amount, index: 0);
    let create_t2 = create_enc_note_input(to: user, token: token_2_addr, :amount, index: 0);
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                set_viewing_key_action(), open_channel_action(from: user, to: user, index: 0),
                open_subchannel_action(from: user, to: user, token_addr: token_1_addr, index: 0),
                open_subchannel_action(from: user, to: user, token_addr: token_2_addr, index: 1),
                deposit_action(token_1_addr, amount), deposit_action(token_2_addr, amount),
                ClientAction::CreateEncNote(create_t1), ClientAction::CreateEncNote(create_t2),
            ]
                .span(),
        );
    assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
    assert_eq!(token_2.balance_of(address: test.privacy.address), amount.into());
    assert_eq!(token_1.balance_of(address: user.address), Zero::zero());
    assert_eq!(token_2.balance_of(address: user.address), Zero::zero());
    let (note_id_t1, expected_t1) = user.compute_enc_note(create_note_input: create_t1);
    let (note_id_t2, expected_t2) = user.compute_enc_note(create_note_input: create_t2);
    assert_eq!(test.privacy.get_note(note_id: note_id_t1), expected_t1);
    assert_eq!(test.privacy.get_note(note_id: note_id_t2), expected_t2);

    // Tx2: multi-action, multi-token — UseNote(token_1) + UseNote(token_2) + Withdraw(token_1) +
    // Withdraw(token_2)
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                use_note_action(channel_key_self, token_1_addr, 0),
                use_note_action(channel_key_self, token_2_addr, 0),
                withdraw_action(user.address, token_1_addr, amount),
                withdraw_action(user.address, token_2_addr, amount),
            ]
                .span(),
        );
    assert_eq!(token_1.balance_of(address: user.address), amount.into());
    assert_eq!(token_2.balance_of(address: user.address), amount.into());
    assert_eq!(token_1.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token_2.balance_of(address: test.privacy.address), Zero::zero());
    let nullifier = user.compute_nullifier(sender: user, token_addr: token_1_addr, index: 0);
    assert!(test.privacy.nullifier_exists(:nullifier));
    let nullifier = user.compute_nullifier(sender: user, token_addr: token_2_addr, index: 0);
    assert!(test.privacy.nullifier_exists(:nullifier));
}

/// Invokes Vesu Lending Helper (deposit underlying → vault, then withdraw vault → underlying).
#[test]
fn test_e2e_vesu_invoke() {
    let mut test: Test = Default::default();
    let vesu = test.deploy_vesu_components();
    let mut user = test.new_user();
    let underlying_token_addr = vesu.underlying_token.contract_address();
    let vault_addr = vesu.vault;
    let helper_addr = vesu.lending_helper;
    let amount = 100_u128;

    user.increase_token_balance(token: vesu.underlying_token, :amount);
    user.approve(token: vesu.underlying_token, amount: amount.into());

    let channel_key_self = user.compute_channel_key(recipient: user);

    // Tx 1: SetViewingKey + OpenChannel(self) + OpenSubchannel(underlying) + Deposit +
    // CreateEncNote (underlying, to self)
    let create_note_0 = create_enc_note_input(
        to: user, token: underlying_token_addr, :amount, index: 0,
    );
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                set_viewing_key_action(), open_channel_action(from: user, to: user, index: 0),
                open_subchannel_action(
                    from: user, to: user, token_addr: underlying_token_addr, index: 0,
                ),
                deposit_action(token_addr: underlying_token_addr, :amount),
                ClientAction::CreateEncNote(create_note_0),
            ]
                .span(),
        );
    assert_eq!(vesu.underlying_token.balance_of(address: test.privacy.address), amount.into());
    let (note_id_0, note_0) = user.compute_enc_note(create_note_input: create_note_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);

    // Tx 2 (vesu deposit): UseNote + Withdraw(underlying to helper) + OpenSubchannel(vault) +
    // CreateOpenNote(vault) + InvokeExternal(vesu deposit)
    let create_open_vault = user
        .new_open_note_with_generated_random(recipient: user, token_addr: vault_addr, index: 0);
    let (open_note_vault_id, _) = user.compute_open_note(create_note_input: create_open_vault);
    let invoke_deposit = vesu
        .invoke_vesu_deposit_external_input(assets: amount, note_id: open_note_vault_id);
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                open_subchannel_action(from: user, to: user, token_addr: vault_addr, index: 1),
                use_note_action(channel_key_self, token_addr: underlying_token_addr, index: 0),
                ClientAction::CreateOpenNote(create_open_vault),
                withdraw_action(to_addr: helper_addr, token_addr: underlying_token_addr, :amount),
                ClientAction::InvokeExternal(invoke_deposit),
            ]
                .span(),
        );
    let nullifier_0 = user
        .compute_nullifier(sender: user, token_addr: underlying_token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    assert_eq!(vesu.underlying_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: helper_addr), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: vault_addr), amount.into());
    assert_eq!(vesu.vault_balance_of(address: helper_addr), 0);
    assert_eq!(vesu.vault_balance_of(address: vault_addr), 0);
    assert_eq!(vesu.vault_balance_of(address: test.privacy.address), amount.into());
    let filled_vault_note = test.privacy.get_note(note_id: open_note_vault_id);
    let (filled_salt, filled_amount) = unpack(packed_value: filled_vault_note.packed_value);
    assert_eq!(filled_salt, OPEN_NOTE_SALT);
    assert_eq!(filled_amount, amount);
    assert_eq!(filled_vault_note.token, vault_addr);

    // Tx 3 (vesu withdraw): UseNote(vault) + CreateOpenNote(underlying) +
    // Withdraw(vault to helper) + InvokeExternal(vesu withdraw)
    let create_open_underlying = user
        .new_open_note_with_generated_random(
            recipient: user, token_addr: underlying_token_addr, index: 1,
        );
    let (open_note_underlying_id, _) = user
        .compute_open_note(create_note_input: create_open_underlying);
    let invoke_withdraw = vesu
        .invoke_vesu_withdraw_external_input(assets: amount, note_id: open_note_underlying_id);
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                use_note_action(channel_key_self, token_addr: vault_addr, index: 0),
                ClientAction::CreateOpenNote(create_open_underlying),
                withdraw_action(to_addr: helper_addr, token_addr: vault_addr, :amount),
                ClientAction::InvokeExternal(invoke_withdraw),
            ]
                .span(),
        );
    let nullifier_vault = user.compute_nullifier(sender: user, token_addr: vault_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_vault));
    assert_eq!(vesu.vault_balance_of(address: test.privacy.address), 0);
    assert_eq!(vesu.vault_balance_of(address: helper_addr), 0);
    assert_eq!(vesu.vault_balance_of(address: vault_addr), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: helper_addr), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: vault_addr), 0);
    assert_eq!(vesu.underlying_token.balance_of(address: test.privacy.address), amount.into());
    let filled_underlying_note = test.privacy.get_note(note_id: open_note_underlying_id);
    let (filled_salt, filled_amount) = unpack(packed_value: filled_underlying_note.packed_value);
    assert_eq!(filled_salt, OPEN_NOTE_SALT);
    assert_eq!(filled_amount, amount);
    assert_eq!(filled_underlying_note.token, underlying_token_addr);
}

/// E2E: deposit input token, withdraw to ekubo helper, swap via InvokeExternal, verify open note.
#[test]
fn test_e2e_ekubo_invoke() {
    let mut test: Test = Default::default();
    let ekubo = test.deploy_ekubo_components();
    let mut user = test.new_user();
    let input_token_addr = ekubo.input_token.contract_address();
    let output_token_addr = ekubo.output_token.contract_address();
    let helper_addr = ekubo.swap_helper;
    let amount = 100_u128;

    user.increase_token_balance(token: ekubo.input_token, :amount);
    user.approve(token: ekubo.input_token, amount: amount.into());
    // Fund the mock router with output tokens for the 1:1 swap.
    ekubo.output_token.supply(address: ekubo.router, amount: amount);

    let channel_key_self = user.compute_channel_key(recipient: user);

    // Tx 1: SetViewingKey + OpenChannel(self) + OpenSubchannel(input) + Deposit +
    // CreateEncNote (input, to self)
    let create_note_0 = create_enc_note_input(to: user, token: input_token_addr, :amount, index: 0);
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                set_viewing_key_action(), open_channel_action(from: user, to: user, index: 0),
                open_subchannel_action(
                    from: user, to: user, token_addr: input_token_addr, index: 0,
                ),
                deposit_action(token_addr: input_token_addr, :amount),
                ClientAction::CreateEncNote(create_note_0),
            ]
                .span(),
        );
    assert_eq!(ekubo.input_token.balance_of(address: test.privacy.address), amount.into());

    // Tx 2 (swap): UseNote(input) + Withdraw(input to helper) + OpenSubchannel(output) +
    // CreateOpenNote(output) + InvokeExternal(ekubo swap)
    let create_open_output = user
        .new_open_note_with_generated_random(
            recipient: user, token_addr: output_token_addr, index: 0,
        );
    let (open_note_output_id, _) = user.compute_open_note(create_note_input: create_open_output);
    let invoke_swap_calldata = build_ekubo_swap_helper_calldata(
        router_addr: ekubo.router,
        token_amount: TokenAmount {
            token: ekubo.input_token.contract_address(), amount: i129 { mag: amount, sign: false },
        },
        pool_key: pool_key_for_tokens(
            ekubo.input_token.contract_address(), ekubo.output_token.contract_address(),
        ),
        minimum_received: 0,
        skip_ahead: 0,
        note_id: open_note_output_id,
    );
    let invoke_swap = InvokeExternalInput {
        contract_address: ekubo.swap_helper, calldata: invoke_swap_calldata.span(),
    };
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                open_subchannel_action(
                    from: user, to: user, token_addr: output_token_addr, index: 1,
                ),
                use_note_action(channel_key_self, token_addr: input_token_addr, index: 0),
                ClientAction::CreateOpenNote(create_open_output),
                withdraw_action(to_addr: helper_addr, token_addr: input_token_addr, :amount),
                ClientAction::InvokeExternal(invoke_swap),
            ]
                .span(),
        );

    // Input tokens consumed: privacy has 0, helper has 0, router received them.
    let nullifier_0 = user.compute_nullifier(sender: user, token_addr: input_token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    assert_eq!(ekubo.input_token.balance_of(address: test.privacy.address), 0);
    assert_eq!(ekubo.input_token.balance_of(address: helper_addr), 0);
    assert_eq!(ekubo.input_token.balance_of(address: ekubo.router), 0);
    // Output tokens: privacy received them via open note deposit.
    assert_eq!(ekubo.output_token.balance_of(address: test.privacy.address), amount.into());
    assert_eq!(ekubo.output_token.balance_of(address: helper_addr), 0);
    assert_eq!(ekubo.output_token.balance_of(address: ekubo.router), 0);
    // Open note filled with output amount.
    let filled_note = test.privacy.get_note(note_id: open_note_output_id);
    let (filled_salt, filled_amount) = unpack(packed_value: filled_note.packed_value);
    assert_eq!(filled_salt, OPEN_NOTE_SALT);
    assert_eq!(filled_amount, amount);
    assert_eq!(filled_note.token, output_token_addr);
}
