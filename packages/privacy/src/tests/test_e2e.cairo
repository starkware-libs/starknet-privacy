//! Single end-to-end test: run each client action one by one via `execute_actions_e2e`, then
//! assert contract state with views. No cheats (no apply_actions, no cheat_*, no internal_*).

use core::num::traits::Zero;
use privacy::actions::{
    ClientAction, CreateEncNoteInput, DepositInput, OpenChannelInput, OpenSubchannelInput,
    SetViewingKeyInput, UseNoteInput, WithdrawInput,
};
use privacy::objects::OpenNoteDeposit;
use privacy::tests::utils_for_tests::{PrivacyCfgTrait, Test, TestTrait, UserTrait};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::{encrypt_channel_info, unpack};
use snforge_std::TokenTrait;
use starkware_utils_testing::test_utils::TokenHelperTrait;

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
    let random_1 = user_1.get_random();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [ClientAction::SetViewingKey(SetViewingKeyInput { random: random_1 })]
                .span(),
        );
    assert_eq!(user_1.get_public_key(), user_1.public_key);
    assert_eq!(user_1.get_enc_private_key(), user_1.compute_enc_private_key(random: random_1));

    // 2. SetViewingKey (user_2)
    let random_2 = user_2.get_random();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_2.address,
            user_private_key: user_2.private_key,
            client_actions: [ClientAction::SetViewingKey(SetViewingKeyInput { random: random_2 })]
                .span(),
        );
    assert_eq!(user_2.get_public_key(), user_2.public_key);
    assert_eq!(user_2.get_enc_private_key(), user_2.compute_enc_private_key(random: random_2));

    // 3. OpenChannel (user_1 -> user_2)
    let random_ch = user_1.get_random();
    let salt_ch: felt252 = user_1.get_salt().into();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        recipient_addr: user_2.address, index: 0, random: random_ch, salt: salt_ch,
                    },
                )
            ]
                .span(),
        );
    let channel_marker = user_1.compute_channel_marker(recipient: user_2);
    let channel_key = user_1.compute_channel_key(recipient: user_2);
    assert!(test.privacy.channel_exists(:channel_marker));
    assert_eq!(user_2.get_num_of_channels(), 1);
    let expected_enc_channel_info = encrypt_channel_info(
        ephemeral_secret: random_ch,
        recipient_public_key: user_2.public_key,
        :channel_key,
        sender_addr: user_1.address,
    );
    assert_eq!(user_2.get_channel_info(channel_index: 0), expected_enc_channel_info);

    // 4. OpenSubchannel (user_1 -> user_2, token)
    let salt_sub: felt252 = user_1.get_salt().into();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user_2.address,
                        recipient_public_key: user_2.public_key,
                        channel_key,
                        index: 0,
                        token: token_addr,
                        salt: salt_sub,
                    },
                )
            ]
                .span(),
        );
    let subchannel_marker = user_1.compute_subchannel_marker(recipient: user_2, :token_addr);
    assert!(test.privacy.subchannel_exists(:subchannel_marker));
    let subchannel_id = user_1.compute_subchannel_id(recipient: user_2, index: 0);
    let expected_enc_subchannel_info = user_1
        .compute_enc_subchannel_info(recipient: user_2, :token_addr, index: 0, salt: salt_sub);
    assert_eq!(test.privacy.get_subchannel_info(:subchannel_id), expected_enc_subchannel_info);

    // 4b. OpenSubchannel (user_1 -> user_2, out_token) for CreateOpenNote + InvokeExternal later
    let salt_sub_out: felt252 = user_1.get_salt().into();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user_2.address,
                        recipient_public_key: user_2.public_key,
                        channel_key,
                        index: 1,
                        token: out_token_addr,
                        salt: salt_sub_out,
                    },
                )
            ]
                .span(),
        );

    // 5. Deposit + CreateEncNote + CreateEncNote (user_1: deposit 100, create two notes of 50 each;
    // one tx so final balance is zero)
    let salt_note_0 = user_1.get_salt();
    let create_note_0 = CreateEncNoteInput {
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        token: token_addr,
        amount: amount_half,
        index: 0,
        salt: salt_note_0,
    };
    let salt_note_1 = user_1.get_salt();
    let create_note_1 = CreateEncNoteInput {
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        token: token_addr,
        amount: amount_half,
        index: 1,
        salt: salt_note_1,
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_addr, amount: amount_total }),
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
    let use_note_0 = UseNoteInput { channel_key, token: token_addr, index: 0 };
    let withdraw_random_1 = user_2.get_random();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_2.address,
            user_private_key: user_2.private_key,
            client_actions: [
                ClientAction::UseNote(use_note_0),
                ClientAction::Withdraw(
                    WithdrawInput {
                        to_addr: user_1.address,
                        token: token_addr,
                        amount: amount_half,
                        random: withdraw_random_1,
                    },
                ),
            ]
                .span(),
        );
    let nullifier_0 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));
    assert_eq!(token.balance_of(address: user_1.address), amount_half.into());
    assert_eq!(token.balance_of(address: test.privacy.address), amount_half.into());

    // 8. CreateOpenNote + InvokeExternal(echo) (user_1: open note for user_2, depositor =
    // echo_executor, deposited to via echo executor in the same tx)
    let create_open_note_input = user_1
        .new_open_note_with_generated_random(
            recipient: user_2,
            token_addr: out_token_addr,
            index: 0,
            depositor: test.privacy.echo_executor,
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
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::CreateOpenNote(create_open_note_input),
                ClientAction::InvokeExternal(echo_invoke),
            ]
                .span(),
        );
    let note_after_deposit = test.privacy.get_note(note_id: open_note_id);
    assert_eq!(note_after_deposit.token, out_token_addr);
    assert_eq!(note_after_deposit.depositor, test.privacy.echo_executor);
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
    let use_note_1 = UseNoteInput { channel_key, token: token_addr, index: 1 };
    let withdraw_random_2 = user_2.get_random();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_2.address,
            user_private_key: user_2.private_key,
            client_actions: [
                ClientAction::UseNote(use_note_1),
                ClientAction::Withdraw(
                    WithdrawInput {
                        to_addr: user_1.address,
                        token: token_addr,
                        amount: amount_half,
                        random: withdraw_random_2,
                    },
                ),
            ]
                .span(),
        );
    let nullifier_1 = user_2.compute_nullifier(sender: user_1, :token_addr, index: 1);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_1));
    assert_eq!(token.balance_of(address: test.privacy.address), Zero::zero());
    assert_eq!(token.balance_of(address: user_1.address), amount_total.into());
}

// --- Dedicated e2e: deposit + withdraw flow ---

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
    let random = user.get_random();
    let salt_ch: felt252 = user.get_salt().into();
    let salt_sub: felt252 = user.get_salt().into();
    let salt_note_0 = user.get_salt();
    let channel_key_self = user.compute_channel_key(recipient: user);
    let create_note_0 = CreateEncNoteInput {
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token: token_addr,
        amount,
        index: 0,
        salt: salt_note_0,
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user.address,
            user_private_key: user.private_key,
            client_actions: [
                ClientAction::SetViewingKey(SetViewingKeyInput { random }),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        recipient_addr: user.address,
                        index: 0,
                        random: user.get_random(),
                        salt: salt_ch,
                    },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key: channel_key_self,
                        index: 0,
                        token: token_addr,
                        salt: salt_sub,
                    },
                ),
                ClientAction::Deposit(DepositInput { token: token_addr, amount }),
                ClientAction::CreateEncNote(create_note_0),
            ]
                .span(),
        );
    assert_eq!(token.balance_of(address: test.privacy.address), amount.into());
    let (note_id_0, note_0) = user.compute_enc_note(create_note_input: create_note_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);

    // Tx 2: Deposit + CreateEncNote (to self, index 1)
    let salt_note_1 = user.get_salt();
    let create_note_1 = CreateEncNoteInput {
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token: token_addr,
        amount,
        index: 1,
        salt: salt_note_1,
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user.address,
            user_private_key: user.private_key,
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_addr, amount }),
                ClientAction::CreateEncNote(create_note_1),
            ]
                .span(),
        );
    assert_eq!(token.balance_of(address: test.privacy.address), (2 * amount).into());
    let (note_id_1, note_1) = user.compute_enc_note(create_note_input: create_note_1);
    assert_eq!(test.privacy.get_note(note_id: note_id_1), note_1);

    // Tx 3: Use both notes + Withdraw
    let use_0 = UseNoteInput { channel_key: channel_key_self, token: token_addr, index: 0 };
    let use_1 = UseNoteInput { channel_key: channel_key_self, token: token_addr, index: 1 };
    let withdraw_random = user.get_random();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user.address,
            user_private_key: user.private_key,
            client_actions: [
                ClientAction::UseNote(use_0), ClientAction::UseNote(use_1),
                ClientAction::Withdraw(
                    WithdrawInput {
                        to_addr: user.address,
                        token: token_addr,
                        amount: 2 * amount,
                        random: withdraw_random,
                    },
                ),
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

// --- Dedicated e2e: transfer flow (3 deposits, then 3 transfers to user_2) ---

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
    let random_1 = user_1.get_random();
    let salt_ch: felt252 = user_1.get_salt().into();
    let salt_sub: felt252 = user_1.get_salt().into();
    let create_0 = CreateEncNoteInput {
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        token: token_addr,
        amount,
        index: 0,
        salt: user_1.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::SetViewingKey(SetViewingKeyInput { random: random_1 }),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        recipient_addr: user_1.address,
                        index: 0,
                        random: user_1.get_random(),
                        salt: salt_ch,
                    },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user_1.address,
                        recipient_public_key: user_1.public_key,
                        channel_key: channel_key_self,
                        index: 0,
                        token: token_addr,
                        salt: salt_sub,
                    },
                ),
                ClientAction::Deposit(DepositInput { token: token_addr, amount }),
                ClientAction::CreateEncNote(create_0),
            ]
                .span(),
        );

    // Tx 2: Deposit + CreateEncNote (to self, index 1)
    let create_1 = CreateEncNoteInput {
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        token: token_addr,
        amount,
        index: 1,
        salt: user_1.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_addr, amount }),
                ClientAction::CreateEncNote(create_1),
            ]
                .span(),
        );

    // Tx 3: Deposit + CreateEncNote (to self, index 2)
    let create_2 = CreateEncNoteInput {
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        token: token_addr,
        amount,
        index: 2,
        salt: user_1.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_addr, amount }),
                ClientAction::CreateEncNote(create_2),
            ]
                .span(),
        );

    // Tx 4: SetViewingKey (user_2)
    let random_2 = user_2.get_random();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_2.address,
            user_private_key: user_2.private_key,
            client_actions: [ClientAction::SetViewingKey(SetViewingKeyInput { random: random_2 })]
                .span(),
        );

    // Tx 5: First transfer — OpenChannel(user_1->user_2) at outgoing index 1, OpenSubchannel, Use
    // 2 notes (0,1), CreateEncNote for user_2, CreateEncNote for self (surplus)
    let channel_key_1_2 = user_1.compute_channel_key(recipient: user_2);
    let amt_to_2 = 60_u128;
    let surplus = 2 * amount - amt_to_2; // 140
    let create_for_2_t1 = CreateEncNoteInput {
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        token: token_addr,
        amount: amt_to_2,
        index: 0,
        salt: user_1.get_salt(),
    };
    let create_self_3 = CreateEncNoteInput {
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        token: token_addr,
        amount: surplus,
        index: 3,
        salt: user_1.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        recipient_addr: user_2.address,
                        index: 1,
                        random: user_1.get_random(),
                        salt: user_1.get_salt().into(),
                    },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user_2.address,
                        recipient_public_key: user_2.public_key,
                        channel_key: channel_key_1_2,
                        index: 0,
                        token: token_addr,
                        salt: user_1.get_salt().into(),
                    },
                ),
                ClientAction::UseNote(
                    UseNoteInput { channel_key: channel_key_self, token: token_addr, index: 0 },
                ),
                ClientAction::UseNote(
                    UseNoteInput { channel_key: channel_key_self, token: token_addr, index: 1 },
                ),
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
    let create_for_2_t2 = CreateEncNoteInput {
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        token: token_addr,
        amount: amt_to_2_t2,
        index: 1,
        salt: user_1.get_salt(),
    };
    let create_self_4 = CreateEncNoteInput {
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        token: token_addr,
        amount: surplus_2,
        index: 4,
        salt: user_1.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::UseNote(
                    UseNoteInput { channel_key: channel_key_self, token: token_addr, index: 2 },
                ),
                ClientAction::UseNote(
                    UseNoteInput { channel_key: channel_key_self, token: token_addr, index: 3 },
                ),
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
    let create_for_2_t3 = CreateEncNoteInput {
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        token: token_addr,
        amount: surplus_2,
        index: 2,
        salt: user_1.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::UseNote(
                    UseNoteInput { channel_key: channel_key_self, token: token_addr, index: 4 },
                ),
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
    let channel_key_2_self = user_2.compute_channel_key(recipient: user_2);
    let create_merged = CreateEncNoteInput {
        recipient_addr: user_2.address,
        recipient_public_key: user_2.public_key,
        token: token_addr,
        amount: 3 * amount,
        index: 0,
        salt: user_2.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_2.address,
            user_private_key: user_2.private_key,
            client_actions: [
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        recipient_addr: user_2.address,
                        index: 0,
                        random: user_2.get_random(),
                        salt: user_2.get_salt().into(),
                    },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user_2.address,
                        recipient_public_key: user_2.public_key,
                        channel_key: channel_key_2_self,
                        index: 0,
                        token: token_addr,
                        salt: user_2.get_salt().into(),
                    },
                ),
                ClientAction::UseNote(
                    UseNoteInput { channel_key: channel_key_1_2, token: token_addr, index: 0 },
                ),
                ClientAction::UseNote(
                    UseNoteInput { channel_key: channel_key_1_2, token: token_addr, index: 1 },
                ),
                ClientAction::UseNote(
                    UseNoteInput { channel_key: channel_key_1_2, token: token_addr, index: 2 },
                ),
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

// --- E2E: two actions per tx where possible (test_e2e_actions_twice) ---

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
    let random_1 = user_1.get_random();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [ClientAction::SetViewingKey(SetViewingKeyInput { random: random_1 })]
                .span(),
        );

    // 2. user2 set viewing key
    let random_2 = user_2.get_random();
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_2.address,
            user_private_key: user_2.private_key,
            client_actions: [ClientAction::SetViewingKey(SetViewingKeyInput { random: random_2 })]
                .span(),
        );

    let channel_key_self = user_1.compute_channel_key(recipient: user_1);

    // 3. user1: 2 open channels in one tx (self, user2)
    let open_self = OpenChannelInput {
        recipient_addr: user_1.address,
        index: 0,
        random: user_1.get_random(),
        salt: user_1.get_salt().into(),
    };
    let open_2 = OpenChannelInput {
        recipient_addr: user_2.address,
        index: 1,
        random: user_1.get_random(),
        salt: user_1.get_salt().into(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::OpenChannel(open_self), ClientAction::OpenChannel(open_2),
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
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user_1.address,
                        recipient_public_key: user_1.public_key,
                        channel_key: channel_key_self,
                        index: 0,
                        token: token_1_addr,
                        salt: user_1.get_salt().into(),
                    },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user_1.address,
                        recipient_public_key: user_1.public_key,
                        channel_key: channel_key_self,
                        index: 1,
                        token: token_2_addr,
                        salt: user_1.get_salt().into(),
                    },
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
    let create_t1_0 = CreateEncNoteInput {
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        token: token_1_addr,
        amount,
        index: 0,
        salt: user_1.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_1_addr, amount: half }),
                ClientAction::Deposit(DepositInput { token: token_1_addr, amount: half }),
                ClientAction::CreateEncNote(create_t1_0),
            ]
                .span(),
        );
    assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
    let (note_id_0, note_0) = user_1.compute_enc_note(create_note_input: create_t1_0);
    assert_eq!(test.privacy.get_note(note_id: note_id_0), note_0);

    // 6. user1: 1 deposit + 2 create enc note for token 2 (one tx)
    let create_t2_0 = CreateEncNoteInput {
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        token: token_2_addr,
        amount: half,
        index: 0,
        salt: user_1.get_salt(),
    };
    let create_t2_1 = CreateEncNoteInput {
        recipient_addr: user_1.address,
        recipient_public_key: user_1.public_key,
        token: token_2_addr,
        amount: half,
        index: 1,
        salt: user_1.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::Deposit(DepositInput { token: token_2_addr, amount }),
                ClientAction::CreateEncNote(create_t2_0), ClientAction::CreateEncNote(create_t2_1),
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
        .new_open_note_with_generated_random(
            recipient: user_1,
            token_addr: token_1_addr,
            index: 1,
            depositor: test.privacy.echo_executor,
        );
    let create_open_note_2 = user_1
        .new_open_note_with_generated_random(
            recipient: user_1,
            token_addr: token_1_addr,
            index: 2,
            depositor: test.privacy.echo_executor,
        );
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
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
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
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::UseNote(use_t1_0),
                ClientAction::Withdraw(
                    WithdrawInput {
                        to_addr: user_1.address,
                        token: token_1_addr,
                        amount: half,
                        random: user_1.get_random(),
                    },
                ),
                ClientAction::Withdraw(
                    WithdrawInput {
                        to_addr: user_1.address,
                        token: token_1_addr,
                        amount: half,
                        random: user_1.get_random(),
                    },
                ),
            ]
                .span(),
        );
    assert_eq!(token_1.balance_of(address: user_1.address), amount.into());
    assert_eq!(token_1.balance_of(address: test.privacy.address), amount.into());
    let nullifier_0 = user_1.compute_nullifier(sender: user_1, token_addr: token_1_addr, index: 0);
    assert!(test.privacy.nullifier_exists(nullifier: nullifier_0));

    // 9. user1: use both notes token 2 + 1 withdraw (one tx)
    let use_t2_0 = UseNoteInput { channel_key: channel_key_self, token: token_2_addr, index: 0 };
    let use_t2_1 = UseNoteInput { channel_key: channel_key_self, token: token_2_addr, index: 1 };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user_1.address,
            user_private_key: user_1.private_key,
            client_actions: [
                ClientAction::UseNote(use_t2_0), ClientAction::UseNote(use_t2_1),
                ClientAction::Withdraw(
                    WithdrawInput {
                        to_addr: user_1.address,
                        token: token_2_addr,
                        amount,
                        random: user_1.get_random(),
                    },
                ),
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

// --- E2E: multi-action and multi-token in one tx ---

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
    let create_t1 = CreateEncNoteInput {
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token: token_1_addr,
        amount,
        index: 0,
        salt: user.get_salt(),
    };
    let create_t2 = CreateEncNoteInput {
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token: token_2_addr,
        amount,
        index: 0,
        salt: user.get_salt(),
    };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user.address,
            user_private_key: user.private_key,
            client_actions: [
                ClientAction::SetViewingKey(SetViewingKeyInput { random: user.get_random() }),
                ClientAction::OpenChannel(
                    OpenChannelInput {
                        recipient_addr: user.address,
                        index: 0,
                        random: user.get_random(),
                        salt: user.get_salt().into(),
                    },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key: channel_key_self,
                        index: 0,
                        token: token_1_addr,
                        salt: user.get_salt().into(),
                    },
                ),
                ClientAction::OpenSubchannel(
                    OpenSubchannelInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        channel_key: channel_key_self,
                        index: 1,
                        token: token_2_addr,
                        salt: user.get_salt().into(),
                    },
                ),
                ClientAction::Deposit(DepositInput { token: token_1_addr, amount }),
                ClientAction::Deposit(DepositInput { token: token_2_addr, amount }),
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
    let use_t1 = UseNoteInput { channel_key: channel_key_self, token: token_1_addr, index: 0 };
    let use_t2 = UseNoteInput { channel_key: channel_key_self, token: token_2_addr, index: 0 };
    test
        .privacy
        .execute_actions_e2e(
            user_addr: user.address,
            user_private_key: user.private_key,
            client_actions: [
                ClientAction::UseNote(use_t1), ClientAction::UseNote(use_t2),
                ClientAction::Withdraw(
                    WithdrawInput {
                        to_addr: user.address,
                        token: token_1_addr,
                        amount,
                        random: user.get_random(),
                    },
                ),
                ClientAction::Withdraw(
                    WithdrawInput {
                        to_addr: user.address,
                        token: token_2_addr,
                        amount,
                        random: user.get_random(),
                    },
                ),
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
