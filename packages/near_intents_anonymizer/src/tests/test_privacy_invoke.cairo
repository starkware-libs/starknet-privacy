//! Unit tests for `NearIntentsAnonymizer.privacy_invoke`.
//!
//! Drives the entrypoint directly while impersonating the privacy pool, so
//! we exercise input validation, auth, depositor-verify roundtrip, slot
//! uniqueness, fund forwarding, and state writes without standing up a real
//! pool tx.

use near_intents_anonymizer::near_intents_anonymizer::{
    INearIntentsAnonymizerDispatcherTrait, SwapStatus,
};
use near_intents_anonymizer::tests::test_utils::{
    DEFAULT_AMOUNT, TestCtx, alice, bob, deploy_test_erc20, erc20, fund, make_open_note,
    one_click_deposit_address, set_pool_note, setup, start_pool_impersonation,
    stop_pool_impersonation,
};
use openzeppelin::interfaces::token::erc20::IERC20DispatcherTrait;
use starkware_utils_testing::test_utils::TokenState;
use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};
use starknet::ContractAddress;

const SWAP_ID: felt252 = 'SWAP_1';
const NOTE_OUT: felt252 = 'NOTE_OUT';
const NOTE_REFUND: felt252 = 'NOTE_REFUND';

/// Standard prep: deploy two tokens, fund the anonymizer with `in_amount` of
/// asset_in, register the two open notes with the anonymizer as depositor.
fn prepare_pending_swap(in_amount: u128) -> (TestCtx, TokenState, TokenState) {
    let ctx = setup();
    let asset_in = deploy_test_erc20();
    let asset_out = deploy_test_erc20();
    fund(asset_in, ctx.anonymizer_addr, in_amount);
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));
    set_pool_note(ctx, NOTE_REFUND, make_open_note(asset_in.address, ctx.anonymizer_addr));
    (ctx, asset_in, asset_out)
}

fn call_start(
    ctx: TestCtx,
    asset_in: ContractAddress,
    in_amount: u128,
    asset_out: ContractAddress,
    swap_id: felt252,
    note_id_out: felt252,
    refund_note_id: felt252,
    deposit_address: ContractAddress,
) {
    start_pool_impersonation(ctx);
    ctx
        .anonymizer
        .privacy_invoke(
            swap_id,
            asset_in,
            in_amount,
            asset_out,
            note_id_out,
            refund_note_id,
            deposit_address,
            0,
        );
    stop_pool_impersonation(ctx);
}

#[test]
fn test_records_state_and_forwards_funds() {
    let (ctx, asset_in, asset_out) = prepare_pending_swap(DEFAULT_AMOUNT);
    let dep = one_click_deposit_address();

    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        dep,
    );

    let swap = ctx.anonymizer.get_swap(SWAP_ID);
    assert(swap.status == SwapStatus::Pending, 'status != Pending');
    assert(swap.asset_in == asset_in.address, 'asset_in mismatch');
    assert(swap.asset_out == asset_out.address, 'asset_out mismatch');
    assert(swap.note_id_out == NOTE_OUT, 'note_id_out mismatch');
    assert(swap.refund_note_id == NOTE_REFUND, 'refund_note_id mismatch');

    let asset_in_erc20 = erc20(asset_in);
    assert(
        asset_in_erc20.balance_of(ctx.anonymizer_addr) == 0_u256, 'anonymizer should hold 0',
    );
    assert(
        asset_in_erc20.balance_of(dep) == DEFAULT_AMOUNT.into(),
        'deposit_address not funded',
    );
}

#[test]
#[should_panic(expected: 'NIA_SWAP_ID_TAKEN')]
fn test_duplicate_swap_id_reverts() {
    let (ctx, asset_in, asset_out) = prepare_pending_swap(DEFAULT_AMOUNT * 2);
    let dep = one_click_deposit_address();

    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        dep,
    );

    // Second call with same swap_id: even with fresh funding, the slot is taken.
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        dep,
    );
}

#[test]
#[should_panic(expected: 'NIA_CALLER_NOT_PRIVACY')]
fn test_caller_not_privacy_reverts() {
    let (ctx, asset_in, asset_out) = prepare_pending_swap(DEFAULT_AMOUNT);
    // No impersonation — caller defaults to whatever snforge supplies (not the pool).
    start_cheat_caller_address(ctx.anonymizer_addr, bob());
    ctx
        .anonymizer
        .privacy_invoke(
            SWAP_ID,
            asset_in.address,
            DEFAULT_AMOUNT,
            asset_out.address,
            NOTE_OUT,
            NOTE_REFUND,
            one_click_deposit_address(),
            0,
        );
    stop_cheat_caller_address(ctx.anonymizer_addr);
}

#[test]
#[should_panic(expected: 'NIA_OUT_DEPOSITOR')]
fn test_output_note_depositor_not_us_reverts() {
    let ctx = setup();
    let asset_in = deploy_test_erc20();
    let asset_out = deploy_test_erc20();
    fund(asset_in, ctx.anonymizer_addr, DEFAULT_AMOUNT);
    // Output note has the wrong depositor (alice, not the anonymizer).
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, alice()));
    set_pool_note(
        ctx, NOTE_REFUND, make_open_note(asset_in.address, ctx.anonymizer_addr),
    );
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        one_click_deposit_address(),
    );
}

#[test]
#[should_panic(expected: 'NIA_REFUND_DEPOSITOR')]
fn test_refund_note_depositor_not_us_reverts() {
    let ctx = setup();
    let asset_in = deploy_test_erc20();
    let asset_out = deploy_test_erc20();
    fund(asset_in, ctx.anonymizer_addr, DEFAULT_AMOUNT);
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));
    set_pool_note(ctx, NOTE_REFUND, make_open_note(asset_in.address, alice()));
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        one_click_deposit_address(),
    );
}

#[test]
#[should_panic(expected: 'NIA_OUT_NOTE_TOK')]
fn test_output_note_wrong_token_reverts() {
    let ctx = setup();
    let asset_in = deploy_test_erc20();
    let asset_out = deploy_test_erc20();
    let unrelated = deploy_test_erc20();
    fund(asset_in, ctx.anonymizer_addr, DEFAULT_AMOUNT);
    // Output note token = unrelated; anonymizer expects asset_out.
    set_pool_note(ctx, NOTE_OUT, make_open_note(unrelated.address, ctx.anonymizer_addr));
    set_pool_note(
        ctx, NOTE_REFUND, make_open_note(asset_in.address, ctx.anonymizer_addr),
    );
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        one_click_deposit_address(),
    );
}

#[test]
#[should_panic(expected: 'NIA_REFUND_NOTE_TOK')]
fn test_refund_note_wrong_token_reverts() {
    let ctx = setup();
    let asset_in = deploy_test_erc20();
    let asset_out = deploy_test_erc20();
    let unrelated = deploy_test_erc20();
    fund(asset_in, ctx.anonymizer_addr, DEFAULT_AMOUNT);
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));
    // Refund note token = unrelated; anonymizer expects asset_in.
    set_pool_note(ctx, NOTE_REFUND, make_open_note(unrelated.address, ctx.anonymizer_addr));
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        one_click_deposit_address(),
    );
}

#[test]
#[should_panic(expected: 'NIA_INSUFFICIENT_BAL')]
fn test_insufficient_balance_reverts() {
    let ctx = setup();
    let asset_in = deploy_test_erc20();
    let asset_out = deploy_test_erc20();
    // Fund less than what we'll claim.
    fund(asset_in, ctx.anonymizer_addr, DEFAULT_AMOUNT - 1);
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));
    set_pool_note(
        ctx, NOTE_REFUND, make_open_note(asset_in.address, ctx.anonymizer_addr),
    );
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        one_click_deposit_address(),
    );
}

#[test]
#[should_panic(expected: 'NIA_ZERO_SWAP_ID')]
fn test_zero_swap_id_reverts() {
    let (ctx, asset_in, asset_out) = prepare_pending_swap(DEFAULT_AMOUNT);
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        0,
        NOTE_OUT,
        NOTE_REFUND,
        one_click_deposit_address(),
    );
}

#[test]
#[should_panic(expected: 'NIA_ZERO_AMOUNT')]
fn test_zero_amount_reverts() {
    let (ctx, asset_in, asset_out) = prepare_pending_swap(DEFAULT_AMOUNT);
    call_start(
        ctx,
        asset_in.address,
        0,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        one_click_deposit_address(),
    );
}

#[test]
#[should_panic(expected: 'NIA_ZERO_DEPOSIT')]
fn test_zero_deposit_address_reverts() {
    let (ctx, asset_in, asset_out) = prepare_pending_swap(DEFAULT_AMOUNT);
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_REFUND,
        0.try_into().unwrap(),
    );
}

#[test]
#[should_panic(expected: 'NIA_NOTE_IDS_EQUAL')]
fn test_identical_note_ids_revert() {
    let (ctx, asset_in, asset_out) = prepare_pending_swap(DEFAULT_AMOUNT);
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        NOTE_OUT,
        NOTE_OUT, // same as note_id_out
        one_click_deposit_address(),
    );
}

#[test]
#[should_panic(expected: 'NIA_ZERO_NOTE_ID')]
fn test_zero_note_id_reverts() {
    let (ctx, asset_in, asset_out) = prepare_pending_swap(DEFAULT_AMOUNT);
    call_start(
        ctx,
        asset_in.address,
        DEFAULT_AMOUNT,
        asset_out.address,
        SWAP_ID,
        0,
        NOTE_REFUND,
        one_click_deposit_address(),
    );
}

