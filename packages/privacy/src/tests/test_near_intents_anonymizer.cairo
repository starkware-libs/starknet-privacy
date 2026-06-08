//! End-to-end integration tests for `NearIntentsAnonymizer` against the real
//! privacy pool.
//!
//! Each test drives the full two-transaction flow:
//!   1. The user submits a privacy-pool tx that bundles:
//!      `UseNote → CreateOpenNote(out, depositor=anonymizer)
//!       → CreateOpenNote(refund, depositor=anonymizer)
//!       → Withdraw(in, anonymizer)
//!       → InvokeExternal(anonymizer.privacy_invoke(...))`.
//!   2. Either `anonymizer.finalize(swap_id)` or
//!      `anonymizer.recover(swap_id)`, signed as a plain tx by anyone.
//!
//! The NEAR Intents cross-chain leg is simulated by minting the relevant
//! token directly to the precomputed mailbox address; we test only the
//! Starknet halves of the flow.

use core::num::traits::Zero;
use near_intents_anonymizer::near_intents_anonymizer::{
    INearIntentsAnonymizerDispatcher, INearIntentsAnonymizerDispatcherTrait, SwapStatus,
};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::actions::{
    ClientAction, CreateOpenNoteInput, DepositInput, InvokeExternalInput, OpenChannelInput,
    OpenSubchannelInput, SetViewingKeyInput, UseNoteInput, WithdrawInput,
};
use privacy::tests::utils_for_tests::{
    CreateOpenNoteInputWithDepositorTrait, PrivacyCfgTrait, Test, TestTrait, User, UserTrait,
};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::unpack;
use snforge_std::{ContractClassTrait, DeclareResultTrait, TokenTrait, declare};
use starknet::{ClassHash, ContractAddress};
use starkware_utils_testing::test_utils::TokenHelperTrait;

// ---- Constants ----
const RANDOM: felt252 = 0x24a7f3e2b1c9d8e6f5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e;
const SALT: felt252 = 0x7f8e9d0c1b2a3948576e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b;
const SWAP_ID: felt252 = 'INT_SWAP';
const IN_AMOUNT: u128 = 1_000_000;
const SETTLED_AMOUNT: u128 = 950_000;

fn one_click_deposit_address() -> ContractAddress {
    'ONECLICK'.try_into().unwrap()
}

fn keeper_address() -> ContractAddress {
    'KEEPER'.try_into().unwrap()
}

// ---- Action builders (local copies of the helpers in test_e2e.cairo) ----
fn set_viewing_key_action() -> ClientAction {
    ClientAction::SetViewingKey(SetViewingKeyInput { random: RANDOM })
}

fn open_channel_action(to: User, index: usize) -> ClientAction {
    ClientAction::OpenChannel(
        OpenChannelInput { recipient_addr: to.address, index, random: RANDOM, salt: SALT },
    )
}

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

fn deposit_action(token_addr: ContractAddress, amount: u128) -> ClientAction {
    ClientAction::Deposit(DepositInput { token: token_addr, amount })
}

fn withdraw_action(
    to_addr: ContractAddress, token_addr: ContractAddress, amount: u128,
) -> ClientAction {
    ClientAction::Withdraw(WithdrawInput { to_addr, token: token_addr, amount, random: RANDOM })
}

fn use_note_action(
    channel_key: felt252, token_addr: ContractAddress, index: usize,
) -> ClientAction {
    ClientAction::UseNote(UseNoteInput { channel_key, token: token_addr, index })
}

fn invoke_external_action(
    contract_address: ContractAddress, calldata: Span<felt252>,
) -> ClientAction {
    ClientAction::InvokeExternal(InvokeExternalInput { contract_address, calldata })
}

fn create_open_note_input(
    user: User, token: ContractAddress, index: usize,
) -> CreateOpenNoteInput {
    CreateOpenNoteInput {
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token,
        index,
        depositor: user.address, // overridden with .with_depositor(anonymizer_addr)
        random: RANDOM,
    }
}

// ---- Anonymizer deploy + calldata helpers ----
fn deploy_anonymizer(privacy_addr: ContractAddress) -> (ContractAddress, ClassHash) {
    let receiver_class = declare("MailboxReceiver").unwrap().contract_class().clone();
    let receiver_class_hash: ClassHash = receiver_class.class_hash;
    let mut ctor = array![];
    ctor.append(privacy_addr.into());
    ctor.append(receiver_class_hash.into());
    let anon_class = declare("NearIntentsAnonymizer").unwrap().contract_class().clone();
    let (anon_addr, _) = anon_class.deploy(@ctor).unwrap();
    (anon_addr, receiver_class_hash)
}

fn build_anonymizer_calldata(
    swap_id: felt252,
    asset_in: ContractAddress,
    in_amount: u128,
    asset_out: ContractAddress,
    note_id_out: felt252,
    refund_note_id: felt252,
    deposit_address: ContractAddress,
    note_id: felt252,
) -> Array<felt252> {
    let mut calldata: Array<felt252> = array![];
    swap_id.serialize(ref calldata);
    asset_in.serialize(ref calldata);
    in_amount.serialize(ref calldata);
    asset_out.serialize(ref calldata);
    note_id_out.serialize(ref calldata);
    refund_note_id.serialize(ref calldata);
    deposit_address.serialize(ref calldata);
    note_id.serialize(ref calldata);
    calldata
}

/// Returns a `Test` with the user registered and self-channels open for both
/// asset_in and asset_out (channel index 0, subchannel index 0 each). The
/// user is also funded with `IN_AMOUNT * 2` of `asset_in` and has approved
/// the pool to pull it. Caller deposits + creates an enc-note in the next tx.
fn setup_user_with_in_token_note(
    ref test: Test,
    user: User,
    asset_in: ContractAddress,
    asset_out: ContractAddress,
    in_amount: u128,
) {
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                set_viewing_key_action(),
                open_channel_action(to: user, index: 0),
                open_subchannel_action(from: user, to: user, token_addr: asset_in, index: 0),
                open_subchannel_action(from: user, to: user, token_addr: asset_out, index: 1),
                deposit_action(asset_in, in_amount),
                ClientAction::CreateEncNote(
                    privacy::actions::CreateEncNoteInput {
                        recipient_addr: user.address,
                        recipient_public_key: user.public_key,
                        token: asset_in,
                        amount: in_amount,
                        index: 0,
                        salt: 0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c,
                    },
                ),
            ]
                .span(),
        );
}

#[test]
fn test_dispatch_then_finalize_e2e() {
    let mut test: Test = Default::default();
    let asset_in_token = test.new_token();
    let asset_out_token = test.new_token();
    let asset_in = asset_in_token.contract_address();
    let asset_out = asset_out_token.contract_address();
    let mut user = test.new_user();

    user.increase_token_balance(token: asset_in_token, amount: IN_AMOUNT);
    user.approve(token: asset_in_token, amount: IN_AMOUNT.into());

    // ---- Tx A: register + open channels + deposit into pool, get a note to spend. ----
    setup_user_with_in_token_note(ref test, user, asset_in, asset_out, IN_AMOUNT);

    // ---- Deploy anonymizer. ----
    let (anonymizer_addr, _) = deploy_anonymizer(test.privacy.address);
    let anonymizer = INearIntentsAnonymizerDispatcher { contract_address: anonymizer_addr };

    // ---- Plan Tx 1: open notes for output (index 0) and refund (index 1) under anonymizer. ----
    let out_input = create_open_note_input(user, asset_out, 0)
        .with_depositor(depositor: anonymizer_addr);
    let refund_input = create_open_note_input(user, asset_in, 1)
        .with_depositor(depositor: anonymizer_addr);
    let (note_id_out, _) = user.compute_open_note(create_note_input: out_input);
    let (refund_note_id, _) = user.compute_open_note(create_note_input: refund_input);
    let channel_key_self = user.compute_channel_key(recipient: user);

    let invoke_calldata = build_anonymizer_calldata(
        SWAP_ID,
        asset_in,
        IN_AMOUNT,
        asset_out,
        note_id_out,
        refund_note_id,
        one_click_deposit_address(),
        0,
    );

    // ---- Tx 1: spend the input note, create two open notes, withdraw to anonymizer, invoke. ----
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                use_note_action(channel_key_self, asset_in, 0),
                ClientAction::CreateOpenNote(out_input),
                ClientAction::CreateOpenNote(refund_input),
                withdraw_action(anonymizer_addr, asset_in, IN_AMOUNT),
                invoke_external_action(anonymizer_addr, invoke_calldata.span()),
            ]
                .span(),
        );

    // Post-Tx-1 invariants.
    let swap = anonymizer.get_swap(SWAP_ID);
    assert(swap.status == SwapStatus::Pending, 'tx1: status != Pending');
    let asset_in_erc20 = IERC20Dispatcher { contract_address: asset_in };
    assert(asset_in_erc20.balance_of(account: anonymizer_addr) == Zero::zero(), 'anon not empty');
    assert(
        asset_in_erc20.balance_of(account: one_click_deposit_address()) == IN_AMOUNT.into(),
        '1click not funded',
    );
    let out_note = test.privacy.get_note(note_id: note_id_out);
    let (out_salt, out_amount) = unpack(packed_value: out_note.packed_value);
    assert(out_salt == OPEN_NOTE_SALT, 'tx1: out note not open');
    assert(out_amount == 0, 'tx1: out note already filled');
    assert(out_note.depositor == anonymizer_addr, 'tx1: out depositor');

    // ---- Simulate NEAR Intents settlement: mint output to the mailbox. ----
    let output_mailbox = anonymizer.output_mailbox(SWAP_ID);
    asset_out_token.supply(address: output_mailbox, amount: SETTLED_AMOUNT);

    // ---- Tx 2: anyone signs finalize. ----
    anonymizer.finalize(SWAP_ID);

    // Final state.
    let swap = anonymizer.get_swap(SWAP_ID);
    assert(swap.status == SwapStatus::Finalized, 'tx2: status != Finalized');
    let asset_out_erc20 = IERC20Dispatcher { contract_address: asset_out };
    assert(asset_out_erc20.balance_of(account: output_mailbox) == Zero::zero(), 'mbx not empty');
    assert(
        asset_out_erc20.balance_of(account: anonymizer_addr) == Zero::zero(),
        'anon out balance',
    );
    assert(
        asset_out_erc20.balance_of(account: test.privacy.address) == SETTLED_AMOUNT.into(),
        'pool not credited',
    );
    let out_note = test.privacy.get_note(note_id: note_id_out);
    let (out_salt, out_amount) = unpack(packed_value: out_note.packed_value);
    assert(out_salt == OPEN_NOTE_SALT, 'tx2: out salt drifted');
    assert(out_amount == SETTLED_AMOUNT, 'tx2: out amount mismatch');
}

#[test]
fn test_dispatch_then_recover_e2e() {
    let mut test: Test = Default::default();
    let asset_in_token = test.new_token();
    let asset_out_token = test.new_token();
    let asset_in = asset_in_token.contract_address();
    let asset_out = asset_out_token.contract_address();
    let mut user = test.new_user();

    user.increase_token_balance(token: asset_in_token, amount: IN_AMOUNT);
    user.approve(token: asset_in_token, amount: IN_AMOUNT.into());
    setup_user_with_in_token_note(ref test, user, asset_in, asset_out, IN_AMOUNT);

    let (anonymizer_addr, _) = deploy_anonymizer(test.privacy.address);
    let anonymizer = INearIntentsAnonymizerDispatcher { contract_address: anonymizer_addr };

    let out_input = create_open_note_input(user, asset_out, 0)
        .with_depositor(depositor: anonymizer_addr);
    let refund_input = create_open_note_input(user, asset_in, 1)
        .with_depositor(depositor: anonymizer_addr);
    let (note_id_out, _) = user.compute_open_note(create_note_input: out_input);
    let (refund_note_id, _) = user.compute_open_note(create_note_input: refund_input);
    let channel_key_self = user.compute_channel_key(recipient: user);

    let invoke_calldata = build_anonymizer_calldata(
        SWAP_ID,
        asset_in,
        IN_AMOUNT,
        asset_out,
        note_id_out,
        refund_note_id,
        one_click_deposit_address(),
        0,
    );
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                use_note_action(channel_key_self, asset_in, 0),
                ClientAction::CreateOpenNote(out_input),
                ClientAction::CreateOpenNote(refund_input),
                withdraw_action(anonymizer_addr, asset_in, IN_AMOUNT),
                invoke_external_action(anonymizer_addr, invoke_calldata.span()),
            ]
                .span(),
        );

    // NEAR Intents fails; refund lands at the refund mailbox instead.
    let refund_mailbox = anonymizer.refund_mailbox(SWAP_ID);
    asset_in_token.supply(address: refund_mailbox, amount: IN_AMOUNT);

    anonymizer.recover(SWAP_ID);

    let swap = anonymizer.get_swap(SWAP_ID);
    assert(swap.status == SwapStatus::Recovered, 'status != Recovered');
    let asset_in_erc20 = IERC20Dispatcher { contract_address: asset_in };
    // The refund note got credited; the output note stays empty.
    let refund_note = test.privacy.get_note(note_id: refund_note_id);
    let (refund_salt, refund_amount) = unpack(packed_value: refund_note.packed_value);
    assert(refund_salt == OPEN_NOTE_SALT, 'refund salt');
    assert(refund_amount == IN_AMOUNT, 'refund amount mismatch');
    let out_note = test.privacy.get_note(note_id: note_id_out);
    let (_, out_amount) = unpack(packed_value: out_note.packed_value);
    assert(out_amount == 0, 'out note should stay empty');
    // Pool received the refund (IN_AMOUNT was already in the pool from Tx A
    // before being withdrawn in Tx 1, then refunded back via the mailbox).
    assert(
        asset_in_erc20.balance_of(account: test.privacy.address) == IN_AMOUNT.into(),
        'pool refund balance',
    );
}

#[test]
#[should_panic(expected: 'NIA_SWAP_NOT_PENDING')]
fn test_finalize_then_recover_reverts_e2e() {
    let mut test: Test = Default::default();
    let asset_in_token = test.new_token();
    let asset_out_token = test.new_token();
    let asset_in = asset_in_token.contract_address();
    let asset_out = asset_out_token.contract_address();
    let mut user = test.new_user();

    user.increase_token_balance(token: asset_in_token, amount: IN_AMOUNT);
    user.approve(token: asset_in_token, amount: IN_AMOUNT.into());
    setup_user_with_in_token_note(ref test, user, asset_in, asset_out, IN_AMOUNT);

    let (anonymizer_addr, _) = deploy_anonymizer(test.privacy.address);
    let anonymizer = INearIntentsAnonymizerDispatcher { contract_address: anonymizer_addr };

    let out_input = create_open_note_input(user, asset_out, 0)
        .with_depositor(depositor: anonymizer_addr);
    let refund_input = create_open_note_input(user, asset_in, 1)
        .with_depositor(depositor: anonymizer_addr);
    let (note_id_out, _) = user.compute_open_note(create_note_input: out_input);
    let (refund_note_id, _) = user.compute_open_note(create_note_input: refund_input);
    let channel_key_self = user.compute_channel_key(recipient: user);

    let invoke_calldata = build_anonymizer_calldata(
        SWAP_ID,
        asset_in,
        IN_AMOUNT,
        asset_out,
        note_id_out,
        refund_note_id,
        one_click_deposit_address(),
        0,
    );
    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                use_note_action(channel_key_self, asset_in, 0),
                ClientAction::CreateOpenNote(out_input),
                ClientAction::CreateOpenNote(refund_input),
                withdraw_action(anonymizer_addr, asset_in, IN_AMOUNT),
                invoke_external_action(anonymizer_addr, invoke_calldata.span()),
            ]
                .span(),
        );

    asset_out_token.supply(address: anonymizer.output_mailbox(SWAP_ID), amount: SETTLED_AMOUNT);
    anonymizer.finalize(SWAP_ID);

    // Even with a real refund deposit, recover must reject because the swap
    // is already Finalized.
    asset_in_token.supply(address: anonymizer.refund_mailbox(SWAP_ID), amount: IN_AMOUNT);
    anonymizer.recover(SWAP_ID);
}

// `privacy_invoke`'s pre-flight depositor + token checks are exercised in
// `packages/near_intents_anonymizer/src/tests/test_privacy_invoke.cairo`.
// The privacy pool's own `deposit_to_open_note` guard (`caller == depositor`)
// is the privacy package's own test responsibility — we trust it here.

// Drop unused helper.
fn _silence_unused() {
    let _ = keeper_address();
}
