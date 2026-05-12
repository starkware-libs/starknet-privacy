//! Unit tests for `NearIntentsAnonymizer.recover` and mutual exclusion vs.
//! `finalize`.

use near_intents_anonymizer::near_intents_anonymizer::{
    INearIntentsAnonymizerDispatcherTrait, SwapStatus,
};
use near_intents_anonymizer::tests::test_utils::{
    DEFAULT_AMOUNT, TestCtx, assert_deposited, deploy_test_erc20, erc20, fund, keeper,
    make_open_note, one_click_deposit_address, set_pool_note, setup, start_pool_impersonation,
    stop_pool_impersonation,
};
use openzeppelin::interfaces::token::erc20::IERC20DispatcherTrait;
use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};
use starkware_utils_testing::test_utils::TokenState;

const SWAP_ID: felt252 = 'SWAP_R';
const NOTE_OUT: felt252 = 'R_NOTE_OUT';
const NOTE_REFUND: felt252 = 'R_NOTE_REFUND';

fn pending_swap(in_amount: u128) -> (TestCtx, TokenState, TokenState) {
    let ctx = setup();
    let asset_in = deploy_test_erc20();
    let asset_out = deploy_test_erc20();
    fund(asset_in, ctx.anonymizer_addr, in_amount);
    set_pool_note(ctx, NOTE_OUT, make_open_note(asset_out.address, ctx.anonymizer_addr));
    set_pool_note(ctx, NOTE_REFUND, make_open_note(asset_in.address, ctx.anonymizer_addr));

    start_pool_impersonation(ctx);
    ctx
        .anonymizer
        .privacy_invoke(
            SWAP_ID,
            asset_in.address,
            in_amount,
            asset_out.address,
            NOTE_OUT,
            NOTE_REFUND,
            one_click_deposit_address(),
            0,
        );
    stop_pool_impersonation(ctx);

    (ctx, asset_in, asset_out)
}

#[test]
fn test_happy_path_credits_refund_note() {
    let (ctx, asset_in, _asset_out) = pending_swap(DEFAULT_AMOUNT);

    let refunded: u128 = DEFAULT_AMOUNT;
    let refund_mailbox = ctx.anonymizer.refund_mailbox(SWAP_ID);
    fund(asset_in, refund_mailbox, refunded);

    ctx.anonymizer.recover(SWAP_ID);

    let asset_in_erc20 = erc20(asset_in);
    assert(asset_in_erc20.balance_of(refund_mailbox) == 0_u256, 'refund mbx empty');
    assert(
        asset_in_erc20.balance_of(ctx.anonymizer_addr) == 0_u256, 'anonymizer empty',
    );
    assert(
        asset_in_erc20.balance_of(ctx.pool_addr) == refunded.into(),
        'pool not credited (refund)',
    );
    assert_deposited(ctx, NOTE_REFUND, refunded);

    let swap = ctx.anonymizer.get_swap(SWAP_ID);
    assert(swap.status == SwapStatus::Recovered, 'status != Recovered');
}

#[test]
fn test_permissionless_caller_can_recover() {
    let (ctx, asset_in, _asset_out) = pending_swap(DEFAULT_AMOUNT);
    let refund_mailbox = ctx.anonymizer.refund_mailbox(SWAP_ID);
    fund(asset_in, refund_mailbox, 7_777);

    start_cheat_caller_address(ctx.anonymizer_addr, keeper());
    ctx.anonymizer.recover(SWAP_ID);
    stop_cheat_caller_address(ctx.anonymizer_addr);

    assert_deposited(ctx, NOTE_REFUND, 7_777);
}

#[test]
#[should_panic(expected: 'NIA_SWAP_NOT_PENDING')]
fn test_finalize_then_recover_reverts() {
    let (ctx, asset_in, asset_out) = pending_swap(DEFAULT_AMOUNT);
    let mailbox = ctx.anonymizer.output_mailbox(SWAP_ID);
    fund(asset_out, mailbox, 1_000);
    ctx.anonymizer.finalize(SWAP_ID);
    // Status is Finalized; recover must reject.
    let refund_mailbox = ctx.anonymizer.refund_mailbox(SWAP_ID);
    fund(asset_in, refund_mailbox, 1_000);
    ctx.anonymizer.recover(SWAP_ID);
}

#[test]
#[should_panic(expected: 'NIA_SWAP_NOT_PENDING')]
fn test_recover_then_finalize_reverts() {
    let (ctx, asset_in, asset_out) = pending_swap(DEFAULT_AMOUNT);
    let refund_mailbox = ctx.anonymizer.refund_mailbox(SWAP_ID);
    fund(asset_in, refund_mailbox, 1_000);
    ctx.anonymizer.recover(SWAP_ID);
    // Status is Recovered; finalize must reject.
    let mailbox = ctx.anonymizer.output_mailbox(SWAP_ID);
    fund(asset_out, mailbox, 1_000);
    ctx.anonymizer.finalize(SWAP_ID);
}

#[test]
#[should_panic(expected: 'NIA_SWAP_NOT_PENDING')]
fn test_unknown_swap_id_reverts() {
    let ctx = setup();
    ctx.anonymizer.recover('UNKNOWN');
}

#[test]
#[should_panic(expected: 'NIA_ZERO_OUT')]
fn test_empty_refund_mailbox_reverts() {
    let (ctx, _asset_in, _asset_out) = pending_swap(DEFAULT_AMOUNT);
    ctx.anonymizer.recover(SWAP_ID);
}
