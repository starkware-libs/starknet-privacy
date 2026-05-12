//! End-to-end integration tests for the inbound (on-ramp) flow of
//! `NearIntentsAnonymizer` against the real privacy pool.
//!
//! Inbound flow shape:
//!   1. User opens a self-channel and creates an open note with
//!      `depositor = anonymizer` (no Withdraw, no InvokeExternal yet — the
//!      user has no shielded balance to spend, they're bringing funds from
//!      another chain).
//!   2. User calls `anonymizer.register_inbound(swap_id, asset_out,
//!      note_id_out, deposit_address_hint)` directly (plain Starknet tx).
//!   3. The foreign-chain leg is simulated by minting `asset_out` to the
//!      precomputed `output_mailbox(effective_swap_id)`.
//!   4. Anyone calls `anonymizer.finalize(effective_swap_id)`; the user's
//!      open note is filled.
//!
//! Anti-griefing key: the swap is stored under `effective_swap_id =
//! pedersen(caller, swap_id)`, not the raw `swap_id`.

use core::num::traits::Zero;
use core::pedersen::pedersen;
use near_intents_anonymizer::near_intents_anonymizer::{
    INearIntentsAnonymizerDispatcher, INearIntentsAnonymizerDispatcherTrait, SwapStatus,
};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::actions::{
    ClientAction, CreateOpenNoteInput, OpenChannelInput, OpenSubchannelInput, SetViewingKeyInput,
};
use privacy::tests::utils_for_tests::{
    CreateOpenNoteInputWithDepositorTrait, PrivacyCfgTrait, Test, TestTrait, User, UserTrait,
};
use privacy::utils::constants::OPEN_NOTE_SALT;
use privacy::utils::unpack;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, EventSpyTrait, EventsFilterTrait, TokenTrait, declare,
    spy_events, start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::{ClassHash, ContractAddress};
use starkware_utils_testing::test_utils::TokenHelperTrait;

const RANDOM: felt252 = 0x24a7f3e2b1c9d8e6f5a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e;
const SALT: felt252 = 0x7f8e9d0c1b2a3948576e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b;
const SWAP_ID: felt252 = 'INBOUND_SWAP';
const DEPOSIT_HINT: felt252 = 'depositAddr@solana';
const SETTLED_AMOUNT: u128 = 1_500_000;

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

fn create_open_note_input(
    user: User, token: ContractAddress, index: usize,
) -> CreateOpenNoteInput {
    CreateOpenNoteInput {
        recipient_addr: user.address,
        recipient_public_key: user.public_key,
        token,
        index,
        depositor: user.address, // overridden via .with_depositor(anonymizer_addr)
        random: RANDOM,
    }
}

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

#[test]
fn test_register_then_finalize_inbound_e2e() {
    let mut test: Test = Default::default();
    let asset_out_token = test.new_token();
    let asset_out = asset_out_token.contract_address();
    let mut user = test.new_user();

    let (anonymizer_addr, _) = deploy_anonymizer(test.privacy.address);
    let anonymizer = INearIntentsAnonymizerDispatcher { contract_address: anonymizer_addr };

    // ---- Pool tx: register identity, open self-channel + subchannel for
    //      asset_out, and create the open note with depositor=anonymizer. ----
    let out_input = create_open_note_input(user, asset_out, 0)
        .with_depositor(depositor: anonymizer_addr);
    let (note_id_out, _) = user.compute_open_note(create_note_input: out_input);

    test
        .privacy
        .execute_actions_e2e(
            :user,
            client_actions: [
                set_viewing_key_action(),
                open_channel_action(to: user, index: 0),
                open_subchannel_action(from: user, to: user, token_addr: asset_out, index: 0),
                ClientAction::CreateOpenNote(out_input),
            ]
                .span(),
        );

    // Pre-register invariants: open note exists, depositor=anonymizer,
    // amount=0, the anonymizer slot is empty.
    let out_note_before = test.privacy.get_note(note_id: note_id_out);
    let (out_salt_before, out_amount_before) = unpack(packed_value: out_note_before.packed_value);
    assert(out_salt_before == OPEN_NOTE_SALT, 'pre: note not open');
    assert(out_amount_before == 0, 'pre: note not empty');
    assert(out_note_before.depositor == anonymizer_addr, 'pre: wrong depositor');

    let effective_swap_id = anonymizer.compute_effective_swap_id(user.address, SWAP_ID);
    let raw_pre = anonymizer.get_swap(SWAP_ID);
    let effective_pre = anonymizer.get_swap(effective_swap_id);
    assert(raw_pre.status == SwapStatus::None, 'pre: raw slot taken');
    assert(effective_pre.status == SwapStatus::None, 'pre: eff slot taken');

    // ---- Plain Starknet tx: user calls register_inbound directly. ----
    let mut spy = spy_events();
    start_cheat_caller_address(anonymizer_addr, user.address);
    anonymizer.register_inbound(SWAP_ID, asset_out, note_id_out, DEPOSIT_HINT);
    stop_cheat_caller_address(anonymizer_addr);

    // Post-register invariants.
    let registered = anonymizer.get_swap(effective_swap_id);
    assert(registered.status == SwapStatus::Pending, 'post-reg: not Pending');
    assert(registered.asset_out == asset_out, 'post-reg: asset_out');
    assert(registered.note_id_out == note_id_out, 'post-reg: note_id_out');
    assert(registered.asset_in.is_zero(), 'post-reg: asset_in must be 0');
    assert(registered.refund_note_id == 0, 'post-reg: refund must be 0');
    // Raw slot must remain empty — anti-grief invariant.
    assert(
        anonymizer.get_swap(SWAP_ID).status == SwapStatus::None, 'post-reg: raw leaked',
    );

    // Sanity: the derived effective_swap_id matches the explicit pedersen.
    let pedersen_check = pedersen(user.address.into(), SWAP_ID);
    assert(effective_swap_id == pedersen_check, 'effective formula drift');

    // ---- Simulate the 1Click settlement on Starknet. ----
    let output_mailbox = anonymizer.output_mailbox(effective_swap_id);
    asset_out_token.supply(address: output_mailbox, amount: SETTLED_AMOUNT);

    // ---- finalize, called against effective_swap_id. ----
    anonymizer.finalize(effective_swap_id);

    let after_finalize = anonymizer.get_swap(effective_swap_id);
    assert(after_finalize.status == SwapStatus::Finalized, 'post-fin: not Finalized');

    let asset_out_erc20 = IERC20Dispatcher { contract_address: asset_out };
    assert(
        asset_out_erc20.balance_of(account: output_mailbox) == Zero::zero(),
        'mailbox not empty',
    );
    assert(
        asset_out_erc20.balance_of(account: anonymizer_addr) == Zero::zero(),
        'anonymizer not empty',
    );
    assert(
        asset_out_erc20.balance_of(account: test.privacy.address) == SETTLED_AMOUNT.into(),
        'pool not credited',
    );

    // User's open note now holds the settled amount.
    let out_note_after = test.privacy.get_note(note_id: note_id_out);
    let (out_salt_after, out_amount_after) = unpack(packed_value: out_note_after.packed_value);
    assert(out_salt_after == OPEN_NOTE_SALT, 'post-fin: salt drift');
    assert(out_amount_after == SETTLED_AMOUNT, 'post-fin: amount mismatch');
    assert(out_note_after.token == asset_out, 'post-fin: token drift');
    assert(out_note_after.depositor == anonymizer_addr, 'post-fin: depositor drift');

    // Event log: spy captured the anonymizer's emissions across both calls.
    // We expect exactly two: InboundRegistered (during register_inbound) then
    // SwapFinalized (during finalize). Match by the indexed key in each
    // event — `effective_swap_id` for InboundRegistered, `swap_id` (which
    // for inbound is `effective_swap_id`) for SwapFinalized.
    let anonymizer_events = spy
        .get_events()
        .emitted_by(contract_address: anonymizer_addr)
        .events;
    assert(anonymizer_events.len() == 2, 'expected 2 anon events');
    let (_, registered_event) = anonymizer_events[0];
    assert(*registered_event.keys[1] == effective_swap_id, 'evt0 key != effective');
    let (_, finalized_event) = anonymizer_events[1];
    assert(*finalized_event.keys[1] == effective_swap_id, 'evt1 key != effective');
    // Amount payload of SwapFinalized lives in `.data[0]` (only field).
    assert(*finalized_event.data[0] == SETTLED_AMOUNT.into(), 'evt1 amount mismatch');
}
