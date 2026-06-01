use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use forge_yields_anonymizer::forge_yields_anonymizer::{DepositParams, errors};
use forge_yields_anonymizer::tests::test_utils::{
    ForgeTrait, deploy_forge_components, deploy_mock_forge_gateway_noop,
    deploy_mock_forge_gateway_overflow,
};
use privacy::objects::OpenNoteDeposit;
use snforge_std::TokenTrait;
use starkware_utils_testing::test_utils::{TokenHelperTrait, assert_panic_with_felt_error};

const DEFAULT_AMOUNT: u128 = 1_000_000_000_000_000_000;

fn commit_for(secret: felt252) -> felt252 {
    poseidon_hash_span([secret].span())
}

// ───────────────────────── Deposit
// ─────────────────────────

#[test]
#[test_case(Zero::zero())]
#[test_case(DEFAULT_AMOUNT)]
fn test_deposit(preexisting_balance: u128) {
    let forge = deploy_forge_components();
    let amount = DEFAULT_AMOUNT;
    let note_id: felt252 = 'NOTE_ID';

    forge.underlying_token.supply(address: forge.anonymizer, amount: preexisting_balance + amount);

    let deposits = forge.privacy_invoke_deposit(:amount, :note_id);
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit { note_id: ret_note_id, token, amount: ret_amount } = *deposits[0];
    assert_eq!(ret_note_id, note_id);
    assert_eq!(token, forge.gateway);
    assert_eq!(ret_amount, amount);
    assert_eq!(
        forge.underlying_token.balance_of(address: forge.anonymizer), preexisting_balance.into(),
    );
    assert_eq!(forge.gateway_balance_of(address: forge.anonymizer), amount.into());
}

#[test]
fn test_deposit_insufficient_balance() {
    let forge = deploy_forge_components();
    let result = forge.safe_privacy_invoke_deposit(amount: DEFAULT_AMOUNT, note_id: 'N');
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');
}

#[test]
fn test_deposit_assertions() {
    let forge = deploy_forge_components();
    let underlying = forge.underlying_token.contract_address();
    let gateway = forge.gateway;
    let amount = DEFAULT_AMOUNT.into();

    // ZERO_UNDERLYING
    let result = forge
        .safe_privacy_invoke_deposit_custom(
            DepositParams { gateway, underlying: Zero::zero(), assets: amount, note_id: 'N' },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_UNDERLYING);

    // ZERO_GATEWAY
    let result = forge
        .safe_privacy_invoke_deposit_custom(
            DepositParams { gateway: Zero::zero(), underlying, assets: amount, note_id: 'N' },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_GATEWAY);

    // ZERO_ASSETS
    let result = forge
        .safe_privacy_invoke_deposit_custom(
            DepositParams { gateway, underlying, assets: Zero::zero(), note_id: 'N' },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_ASSETS);

    // TOKENS_EQUAL (underlying == gateway)
    let result = forge
        .safe_privacy_invoke_deposit_custom(
            DepositParams { gateway, underlying: gateway, assets: amount, note_id: 'N' },
        );
    assert_panic_with_felt_error(:result, expected_error: errors::TOKENS_EQUAL);
}

#[test]
fn test_deposit_zero_out_amount() {
    let mut forge = deploy_forge_components();
    let noop_gateway = deploy_mock_forge_gateway_noop(
        underlying_token: forge.underlying_token.contract_address(),
    );
    forge.gateway = noop_gateway;
    let result = forge.safe_privacy_invoke_deposit(amount: DEFAULT_AMOUNT, note_id: 'N');
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_OUT_AMOUNT);
}

#[test]
fn test_deposit_overflow() {
    let mut forge = deploy_forge_components();
    let gateway = deploy_mock_forge_gateway_overflow(
        underlying_token: forge.underlying_token.contract_address(),
    );
    forge.gateway = gateway;
    let result = forge.safe_privacy_invoke_deposit(amount: DEFAULT_AMOUNT, note_id: 'N');
    assert_panic_with_felt_error(:result, expected_error: errors::RECEIVED_AMOUNT_OVERFLOW);
}

// ──────────────────────── Redemption
// ───────────────────────

/// Happy path A: NFT pre-burned by an external party (auto-service / bot) before
/// Alice's privacy claim. Anonymizer detects the burn, skips its own claim call,
/// reads `due_assets_from_id`, and routes to the open note.
#[test]
fn test_claim_after_external_burn() {
    let forge = deploy_forge_components();
    let amount = DEFAULT_AMOUNT;
    let secret: felt252 = 'OPEN_SESAME';
    let commitment = commit_for(secret);

    forge.underlying_token.supply(address: forge.anonymizer, amount: amount.into());
    forge.privacy_invoke_deposit(:amount, note_id: 'N');
    assert_eq!(forge.gateway_balance_of(address: forge.anonymizer), amount.into());

    let deposits = forge.privacy_invoke_request_redeem(shares: amount, :commitment);
    assert_eq!(deposits.len(), 0);
    assert_eq!(forge.gateway_balance_of(address: forge.anonymizer), 0);

    // External actor triggers the gateway claim — NFT burned, underlying on anonymizer.
    forge.external_gateway_claim(redemption_id: 1);

    let claim_note: felt252 = 'CLAIM_NOTE';
    let deposits = forge
        .privacy_invoke_claim_redeem(redemption_id: 1, :secret, note_id: claim_note);
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit {
        note_id: ret_note_id, token: ret_token, amount: ret_amount,
    } = *deposits[0];
    assert_eq!(ret_note_id, claim_note);
    assert_eq!(ret_token, forge.underlying_token.contract_address());
    assert_eq!(ret_amount, amount);
    assert_eq!(forge.underlying_token.balance_of(address: forge.anonymizer), amount.into());
}

/// Happy path B: NFT still alive at the moment of Alice's privacy claim. The
/// anonymizer opportunistically triggers `gateway.claim_redeem` inside the
/// same atomic tx. Net effect identical to Happy path A.
#[test]
fn test_claim_triggers_gateway_atomically() {
    let forge = deploy_forge_components();
    let amount = DEFAULT_AMOUNT;
    let secret: felt252 = 'EAGER_BEAVER';
    let commitment = commit_for(secret);

    forge.underlying_token.supply(address: forge.anonymizer, amount: amount.into());
    forge.privacy_invoke_deposit(:amount, note_id: 'N');
    forge.privacy_invoke_request_redeem(shares: amount, :commitment);
    // NB: NO external_gateway_claim — the anonymizer will call it itself.

    let deposits = forge.privacy_invoke_claim_redeem(redemption_id: 1, :secret, note_id: 'C');
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit { amount: ret_amount, .. } = *deposits[0];
    assert_eq!(ret_amount, amount);
    // Anonymizer received underlying via the in-tx claim call.
    assert_eq!(forge.underlying_token.balance_of(address: forge.anonymizer), amount.into());
}

#[test]
fn test_claim_redeem_bad_secret() {
    let forge = deploy_forge_components();
    let amount = DEFAULT_AMOUNT;
    let commitment = commit_for('CORRECT');

    forge.underlying_token.supply(address: forge.anonymizer, amount: amount.into());
    forge.privacy_invoke_deposit(:amount, note_id: 'N');
    forge.privacy_invoke_request_redeem(shares: amount, :commitment);
    // Wrong secret is checked BEFORE the NFT-burn check, so we don't need to burn here —
    // assertion order matters.

    let result = forge
        .safe_privacy_invoke_claim_redeem(redemption_id: 1, secret: 'WRONG', note_id: 'CLAIM');
    assert_panic_with_felt_error(:result, expected_error: errors::BAD_SECRET);
}

#[test]
fn test_claim_redeem_unknown_id() {
    let forge = deploy_forge_components();
    let result = forge
        .safe_privacy_invoke_claim_redeem(redemption_id: 42, secret: 'WHATEVER', note_id: 'CLAIM');
    assert_panic_with_felt_error(:result, expected_error: errors::UNKNOWN_REDEMPTION);
}

#[test]
fn test_claim_redeem_no_replay() {
    let forge = deploy_forge_components();
    let amount = DEFAULT_AMOUNT;
    let secret: felt252 = 'ONCE_ONLY';
    let commitment = commit_for(secret);

    forge.underlying_token.supply(address: forge.anonymizer, amount: amount.into());
    forge.privacy_invoke_deposit(:amount, note_id: 'N');
    forge.privacy_invoke_request_redeem(shares: amount, :commitment);

    // External service triggers the gateway claim — NFT burned.
    forge.external_gateway_claim(redemption_id: 1);

    // First privacy claim succeeds.
    forge.privacy_invoke_claim_redeem(redemption_id: 1, :secret, note_id: 'C1');

    // Second claim of the same id panics — commitment cleared.
    let result = forge.safe_privacy_invoke_claim_redeem(redemption_id: 1, :secret, note_id: 'C2');
    assert_panic_with_felt_error(:result, expected_error: errors::UNKNOWN_REDEMPTION);
}

#[test]
fn test_request_redeem_assertions() {
    let forge = deploy_forge_components();

    // ZERO_SHARES
    let result = forge.safe_privacy_invoke_request_redeem(shares: 0, commitment: 'C');
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_SHARES);

    // ZERO_COMMITMENT
    let result = forge.safe_privacy_invoke_request_redeem(shares: DEFAULT_AMOUNT, commitment: 0);
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_COMMITMENT);
}
