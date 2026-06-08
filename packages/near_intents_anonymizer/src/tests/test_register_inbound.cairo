//! Unit tests for `NearIntentsAnonymizer.register_inbound`.
//!
//! The inbound flow has no funds-on-Starknet phase at registration time
//! (the user is sending `asset_in` on a foreign chain). We drive the entry
//! point directly while impersonating the user — `register_inbound` is
//! *not* gated by `caller == privacy_address`, anyone can call it.
//!
//! Anti-griefing: the storage slot is keyed by `effective_swap_id =
//! pedersen(caller, swap_id)` so two users can pick the same raw `swap_id`
//! without colliding.

use core::num::traits::Zero;
use core::pedersen::pedersen;
use near_intents_anonymizer::near_intents_anonymizer::{
    INearIntentsAnonymizerDispatcherTrait, SwapStatus,
};
use near_intents_anonymizer::tests::test_utils::{
    TestCtx, alice, bob, deploy_test_erc20, make_open_note, set_pool_note, setup,
};
use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};
use starknet::ContractAddress;

const SWAP_ID: felt252 = 'IN_SWAP_1';
const NOTE_OUT: felt252 = 'IN_NOTE_OUT';
const DEPOSIT_HINT: felt252 = 'depositAddr@eth';

fn call_register(
    ctx: TestCtx,
    user: ContractAddress,
    swap_id: felt252,
    asset_out: ContractAddress,
    note_id_out: felt252,
    deposit_hint: felt252,
) {
    start_cheat_caller_address(ctx.anonymizer_addr, user);
    ctx.anonymizer.register_inbound(swap_id, asset_out, note_id_out, deposit_hint);
    stop_cheat_caller_address(ctx.anonymizer_addr);
}

#[test]
fn test_happy_path_records_pending_inbound() {
    let ctx = setup();
    let asset_out = deploy_test_erc20();
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));

    call_register(ctx, alice(), SWAP_ID, asset_out.address, NOTE_OUT, DEPOSIT_HINT);

    // Storage is at the caller-namespaced key, not the raw swap_id.
    let effective_swap_id = pedersen(alice().into(), SWAP_ID);
    let swap = ctx.anonymizer.get_swap(effective_swap_id);
    assert(swap.status == SwapStatus::Pending, 'status != Pending');
    assert(swap.asset_out == asset_out.address, 'asset_out mismatch');
    assert(swap.note_id_out == NOTE_OUT, 'note_id_out mismatch');
    // Inbound sentinels: no input asset, no refund note.
    assert(swap.asset_in.is_zero(), 'inbound asset_in must be 0');
    assert(swap.refund_note_id == 0, 'inbound refund_note must be 0');

    // Raw swap_id is empty — anti-grief invariant.
    let raw_slot = ctx.anonymizer.get_swap(SWAP_ID);
    assert(raw_slot.status == SwapStatus::None, 'raw swap_id slot taken');
}

#[test]
fn test_compute_effective_swap_id_matches_pedersen() {
    let ctx = setup();
    let derived = ctx.anonymizer.compute_effective_swap_id(alice(), SWAP_ID);
    let expected = pedersen(alice().into(), SWAP_ID);
    assert(derived == expected, 'effective_swap_id formula');
}

#[test]
fn test_two_users_same_swap_id_no_collision() {
    // Anti-griefing: Alice and Bob both register with the same raw `SWAP_ID`
    // — both succeed because the storage key is `pedersen(caller, swap_id)`.
    let ctx = setup();
    let asset_out = deploy_test_erc20();
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));

    call_register(ctx, alice(), SWAP_ID, asset_out.address, NOTE_OUT, DEPOSIT_HINT);
    // Bob shouldn't be locked out.
    call_register(ctx, bob(), SWAP_ID, asset_out.address, NOTE_OUT, DEPOSIT_HINT);

    let alice_effective = pedersen(alice().into(), SWAP_ID);
    let bob_effective = pedersen(bob().into(), SWAP_ID);
    assert(alice_effective != bob_effective, 'effective ids must differ');
    assert(
        ctx.anonymizer.get_swap(alice_effective).status == SwapStatus::Pending, 'alice slot',
    );
    assert(
        ctx.anonymizer.get_swap(bob_effective).status == SwapStatus::Pending, 'bob slot',
    );
}

#[test]
#[should_panic(expected: 'NIA_SWAP_ID_TAKEN')]
fn test_duplicate_registration_reverts() {
    // Same caller, same swap_id, same effective key — second call must
    // revert. (Different callers are tested in
    // `test_two_users_same_swap_id_no_collision`.)
    let ctx = setup();
    let asset_out = deploy_test_erc20();
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));

    call_register(ctx, alice(), SWAP_ID, asset_out.address, NOTE_OUT, DEPOSIT_HINT);
    call_register(ctx, alice(), SWAP_ID, asset_out.address, NOTE_OUT, DEPOSIT_HINT);
}

#[test]
#[should_panic(expected: 'NIA_OUT_DEPOSITOR')]
fn test_wrong_depositor_reverts() {
    let ctx = setup();
    let asset_out = deploy_test_erc20();
    // Note created with the wrong depositor (bob), not the anonymizer.
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, bob()));

    call_register(ctx, alice(), SWAP_ID, asset_out.address, NOTE_OUT, DEPOSIT_HINT);
}

#[test]
#[should_panic(expected: 'NIA_OUT_NOTE_TOK')]
fn test_wrong_note_token_reverts() {
    let ctx = setup();
    let asset_out = deploy_test_erc20();
    let unrelated = deploy_test_erc20();
    // Note registered against `unrelated`; caller asks for `asset_out`.
    set_pool_note(ctx, NOTE_OUT, make_open_note(unrelated.address, ctx.anonymizer_addr));

    call_register(ctx, alice(), SWAP_ID, asset_out.address, NOTE_OUT, DEPOSIT_HINT);
}

#[test]
#[should_panic(expected: 'NIA_ZERO_SWAP_ID')]
fn test_zero_swap_id_reverts() {
    let ctx = setup();
    let asset_out = deploy_test_erc20();
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));
    call_register(ctx, alice(), 0, asset_out.address, NOTE_OUT, DEPOSIT_HINT);
}

#[test]
#[should_panic(expected: 'NIA_ZERO_ASSET_OUT')]
fn test_zero_asset_out_reverts() {
    let ctx = setup();
    call_register(ctx, alice(), SWAP_ID, 0.try_into().unwrap(), NOTE_OUT, DEPOSIT_HINT);
}

#[test]
#[should_panic(expected: 'NIA_ZERO_NOTE_ID')]
fn test_zero_note_id_reverts() {
    let ctx = setup();
    let asset_out = deploy_test_erc20();
    call_register(ctx, alice(), SWAP_ID, asset_out.address, 0, DEPOSIT_HINT);
}

#[test]
#[should_panic(expected: 'NIA_NO_INBOUND_RECOVERY')]
fn test_recover_rejects_inbound_swap() {
    let ctx = setup();
    let asset_out = deploy_test_erc20();
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));
    call_register(ctx, alice(), SWAP_ID, asset_out.address, NOTE_OUT, DEPOSIT_HINT);

    let effective_swap_id = pedersen(alice().into(), SWAP_ID);
    // Even though the slot is Pending, recover must reject because the
    // swap is inbound (no Starknet refund leg).
    ctx.anonymizer.recover(effective_swap_id);
}
