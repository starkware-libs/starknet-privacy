use core::hash::HashStateTrait;
use core::num::traits::{Bounded, Zero};
use core::poseidon::PoseidonTrait;
use privacy::objects::OpenNoteDeposit;
use snforge_std::{DeclareResultTrait, TokenTrait, declare};
use starknet::account::Call;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_accounts::sub_account::{ISubAccountDispatcher, ISubAccountDispatcherTrait};
use starkware_utils_testing::test_utils::{
    TokenHelperTrait, assert_panic_with_felt_error, cheat_caller_address_once,
};
use sub_account_anonymizer::sub_account_anonymizer::{
    ISubAccountAnonymizerDispatcherTrait, ISubAccountAnonymizerSafeDispatcher,
    ISubAccountAnonymizerSafeDispatcherTrait, MAX_SCAN_RANGE, OpenNote, SubAccountInfo,
    commitment_from_partial, errors, partial_commitment,
};
use sub_account_anonymizer::tests::test_utils::{
    Components, ComponentsTrait, PRIVACY, anonymizer_disp, deploy_components,
    deploy_sub_account_anonymizer, deploy_token, transfer_to_caller_call,
};

const AMOUNT: u128 = 1_000_000;
const NOTE_ID: felt252 = 'NOTE_ID';

/// Resolves the `('USER', 'DAPP', nonce)` sub-account via the range view.
fn sub_account_info(anonymizer: ContractAddress, nonce: u64) -> SubAccountInfo {
    let infos = anonymizer_disp(anonymizer)
        .get_sub_accounts(partial_commitment('USER', 'DAPP'), nonce, nonce + 1);
    *infos[0]
}

#[test]
fn test_get_privacy_contract() {
    let anonymizer = deploy_sub_account_anonymizer();
    assert_eq!(anonymizer_disp(anonymizer).get_privacy_contract(), PRIVACY);
}

#[test]
fn test_get_sub_account_class_hash() {
    let anonymizer = deploy_sub_account_anonymizer();
    let expected = *declare("SubAccount").unwrap_syscall().contract_class().class_hash;
    assert_eq!(anonymizer_disp(anonymizer).get_sub_account_class_hash(), expected);
}

#[test]
fn test_get_sub_account_unknown_identity_commitment_is_zero() {
    let anonymizer = deploy_sub_account_anonymizer();
    assert!(anonymizer_disp(anonymizer).get_sub_account('UNKNOWN').is_zero());
}

#[test]
fn test_undeployed_sub_account_resolves_to_computed_address() {
    let anonymizer = deploy_sub_account_anonymizer();
    let info = sub_account_info(anonymizer, 0);
    // Undeployed, but still resolves to the deterministic address it would deploy to.
    assert!(!info.is_deployed);
    assert!(info.address.is_non_zero());
}

#[test]
fn test_privacy_compute_is_two_stage_poseidon() {
    let anonymizer = deploy_sub_account_anonymizer();
    let identity_commitment = anonymizer_disp(anonymizer).privacy_compute('USER', 'DAPP', 7);
    // Two-stage: hash(hash(identity_key, dapp_name), nonce).
    let expected_partial = PoseidonTrait::new().update('USER').update('DAPP').finalize();
    let expected = PoseidonTrait::new().update(expected_partial).update(7).finalize();
    assert_eq!(identity_commitment, expected);
    // The exported helpers reproduce each stage.
    assert_eq!(partial_commitment('USER', 'DAPP'), expected_partial);
    assert_eq!(commitment_from_partial(expected_partial, 7), expected);
}

#[test]
fn test_privacy_compute_is_deterministic_and_distinct() {
    let anonymizer = anonymizer_disp(deploy_sub_account_anonymizer());
    let base = anonymizer.privacy_compute('USER', 'DAPP', 1);
    // Deterministic for the same inputs.
    assert_eq!(base, anonymizer.privacy_compute('USER', 'DAPP', 1));
    // Each input affects the identity commitment.
    assert_ne!(base, anonymizer.privacy_compute('OTHER', 'DAPP', 1));
    assert_ne!(base, anonymizer.privacy_compute('USER', 'OTHER', 1));
    assert_ne!(base, anonymizer.privacy_compute('USER', 'DAPP', 2));
}

#[test]
fn test_invoke_executes_and_collects_open_note() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);

    // Fund the dapp so the sub-account-driven call pays the sub-account `AMOUNT`.
    components.token.supply(address: components.mock_dapp, amount: AMOUNT);

    let deposits = components
        .invoke(
            :identity_commitment,
            calls: array![transfer_to_caller_call(components.mock_dapp, token, AMOUNT)],
            open_notes: array![OpenNote { note_id: NOTE_ID, token }].span(),
        );

    // One deposit returned, matching the collected token/amount.
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, AMOUNT);

    let sub_account = sub_account_info(components.anonymizer, 1).address;
    assert!(sub_account.is_non_zero());
    // Funds flowed dapp -> sub-account -> anonymizer, and the privacy contract is approved to pull.
    assert_eq!(components.token.balance_of(components.mock_dapp), 0);
    assert_eq!(components.token.balance_of(sub_account), 0);
    assert_eq!(components.token.balance_of(components.anonymizer), AMOUNT.into());
    assert_eq!(components.token.allowance(components.anonymizer, PRIVACY), AMOUNT.into());
}

#[test]
#[feature("safe_dispatcher")]
fn test_invoke_only_privacy_contract() {
    let components = deploy_components();
    // No caller cheat: the caller is the test contract, not the privacy contract.
    let safe = ISubAccountAnonymizerSafeDispatcher { contract_address: components.anonymizer };
    let result = safe
        .privacy_invoke_with_computation(
            identity_commitment: 0, calls: array![], open_notes: array![].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::UNAUTHORIZED_CALLER);
}

#[test]
fn test_collects_multiple_open_notes() {
    let components = deploy_components();
    let token_a = components.token;
    let token_b = deploy_token();
    let addr_a = token_a.contract_address();
    let addr_b = token_b.contract_address();
    assert!(addr_a != addr_b);
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);

    let amount_a: u128 = 1_000_000;
    let amount_b: u128 = 2_500_000;
    token_a.supply(address: components.mock_dapp, amount: amount_a);
    token_b.supply(address: components.mock_dapp, amount: amount_b);

    let deposits = components
        .invoke(
            :identity_commitment,
            calls: array![
                transfer_to_caller_call(components.mock_dapp, addr_a, amount_a),
                transfer_to_caller_call(components.mock_dapp, addr_b, amount_b),
            ],
            open_notes: array![
                OpenNote { note_id: 'NOTE_A', token: addr_a },
                OpenNote { note_id: 'NOTE_B', token: addr_b },
            ]
                .span(),
        );

    // One deposit per note, each carrying its own token/amount.
    assert_eq!(deposits.len(), 2);
    let OpenNoteDeposit { note_id: id_a, token: tok_a, amount: amt_a } = *deposits[0];
    assert_eq!(id_a, 'NOTE_A');
    assert_eq!(tok_a, addr_a);
    assert_eq!(amt_a, amount_a);
    let OpenNoteDeposit { note_id: id_b, token: tok_b, amount: amt_b } = *deposits[1];
    assert_eq!(id_b, 'NOTE_B');
    assert_eq!(tok_b, addr_b);
    assert_eq!(amt_b, amount_b);

    assert_eq!(token_a.balance_of(components.mock_dapp), 0);
    assert_eq!(token_b.balance_of(components.mock_dapp), 0);
    assert_eq!(token_a.balance_of(components.anonymizer), amount_a.into());
    assert_eq!(token_b.balance_of(components.anonymizer), amount_b.into());
    assert_eq!(token_a.allowance(components.anonymizer, PRIVACY), amount_a.into());
    assert_eq!(token_b.allowance(components.anonymizer, PRIVACY), amount_b.into());
}

#[test]
fn test_multiple_invokes_run_in_one_call() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);

    let first: u128 = 700_000;
    let second: u128 = 300_000;
    components.token.supply(address: components.mock_dapp, amount: first + second);

    // Two calls in one interaction; both run as the sub-account and their output is combined.
    let deposits = components
        .invoke(
            :identity_commitment,
            calls: array![
                transfer_to_caller_call(components.mock_dapp, token, first),
                transfer_to_caller_call(components.mock_dapp, token, second),
            ],
            open_notes: array![OpenNote { note_id: NOTE_ID, token }].span(),
        );

    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, first + second);
    assert_eq!(components.token.balance_of(components.anonymizer), (first + second).into());
}

#[test]
fn test_invoke_but_not_collect() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);

    components.token.supply(address: components.mock_dapp, amount: AMOUNT);

    let deposits = components
        .invoke(
            :identity_commitment,
            calls: array![transfer_to_caller_call(components.mock_dapp, token, AMOUNT)],
            open_notes: array![].span(),
        );
    assert_eq!(deposits.len(), 0);
    assert_eq!(components.token.balance_of(components.anonymizer), 0);
    let sub_account = sub_account_info(components.anonymizer, 1).address;
    assert_eq!(components.token.balance_of(sub_account), AMOUNT.into());
}

#[test]
fn test_deployed_sub_account_owned_by_anonymizer() {
    let components = deploy_components();
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);
    components.invoke(:identity_commitment, calls: array![], open_notes: array![].span());

    let sub_account = sub_account_info(components.anonymizer, 1).address;
    // The anonymizer is the sub-account's deployer, so it is the only authorized controller.
    assert_eq!(
        ISubAccountDispatcher { contract_address: sub_account }.owner(), components.anonymizer,
    );
}

#[test]
fn test_sub_account_is_reused_per_identity_commitment() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let identity_commitment_a = anonymizer.privacy_compute('USER', 'DAPP', 1);
    let identity_commitment_b = anonymizer.privacy_compute('USER', 'DAPP', 2);
    let no_notes = array![].span();

    components
        .invoke(identity_commitment: identity_commitment_a, calls: array![], open_notes: no_notes);
    let sub_account_a = sub_account_info(components.anonymizer, 1);
    assert!(sub_account_a.is_deployed);

    // Same identity commitment reuses the same sub-account (no redeploy).
    components
        .invoke(identity_commitment: identity_commitment_a, calls: array![], open_notes: no_notes);
    assert_eq!(sub_account_info(components.anonymizer, 1).address, sub_account_a.address);

    // A different identity commitment gets a distinct sub-account.
    components
        .invoke(identity_commitment: identity_commitment_b, calls: array![], open_notes: no_notes);
    let sub_account_b = sub_account_info(components.anonymizer, 2);
    assert!(sub_account_b.is_deployed);
    assert!(sub_account_b.address != sub_account_a.address);
}

#[test]
fn test_sweeps_full_balance_including_preexisting() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);

    // Deploy the sub-account (empty invoke) so we can give it a pre-existing balance.
    components.invoke(:identity_commitment, calls: array![], open_notes: array![].span());
    let sub_account = sub_account_info(components.anonymizer, 1).address;
    let preexisting: u128 = 500_000;
    components.token.supply(address: sub_account, amount: preexisting);

    // The interaction adds `AMOUNT` on top of the pre-existing balance.
    components.token.supply(address: components.mock_dapp, amount: AMOUNT);
    let deposits = components
        .invoke(
            :identity_commitment,
            calls: array![transfer_to_caller_call(components.mock_dapp, token, AMOUNT)],
            open_notes: array![OpenNote { note_id: NOTE_ID, token }].span(),
        );

    // The full balance is swept: pre-existing plus the amount added by the interaction.
    let total = preexisting + AMOUNT;
    assert_eq!(deposits.len(), 1);
    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, total);
    assert_eq!(components.token.balance_of(components.mock_dapp), 0);
    assert_eq!(components.token.balance_of(sub_account), 0);
    assert_eq!(components.token.balance_of(components.anonymizer), total.into());
    assert_eq!(components.token.allowance(components.anonymizer, PRIVACY), total.into());
}

#[test]
#[feature("safe_dispatcher")]
fn test_empty_balance_open_note_reverts() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);

    // No calls and no funds, so the sub-account's balance is zero. A zero-amount deposit would be
    // rejected downstream, so collecting it reverts with `ZERO_BALANCE`.
    cheat_caller_address_once(contract_address: components.anonymizer, caller_address: PRIVACY);
    let safe = ISubAccountAnonymizerSafeDispatcher { contract_address: components.anonymizer };
    let result = safe
        .privacy_invoke_with_computation(
            :identity_commitment,
            calls: array![],
            open_notes: array![OpenNote { note_id: NOTE_ID, token }].span(),
        );
    assert_panic_with_felt_error(:result, expected_error: errors::ZERO_BALANCE);
}

#[test]
fn test_sweeps_remaining_balance_after_invoke_transfers_out() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);

    // Deploy and pre-fund the sub-account.
    components.invoke(:identity_commitment, calls: array![], open_notes: array![].span());
    let sub_account = sub_account_info(components.anonymizer, 1).address;
    let preexisting: u128 = 1_000_000;
    components.token.supply(address: sub_account, amount: preexisting);

    // The invoke makes the sub-account send some tokens out; only the remainder is swept.
    let sink: ContractAddress = 'SINK'.try_into().unwrap();
    let sent: u128 = 300_000;
    let transfer = Call {
        to: token,
        selector: selector!("transfer"),
        calldata: array![sink.into(), sent.into(), 0].span(),
    };
    let deposits = components
        .invoke(
            :identity_commitment,
            calls: array![transfer],
            open_notes: array![OpenNote { note_id: NOTE_ID, token }].span(),
        );

    // The balance left after the outbound transfer is swept; funds sent out are not recovered.
    let remaining = preexisting - sent;
    let OpenNoteDeposit { note_id, token: deposit_token, amount } = *deposits[0];
    assert_eq!(note_id, NOTE_ID);
    assert_eq!(deposit_token, token);
    assert_eq!(amount, remaining);
    assert_eq!(components.token.balance_of(sub_account), 0);
    assert_eq!(components.token.balance_of(components.anonymizer), remaining.into());
    assert_eq!(components.token.balance_of(sink), sent.into());
}

#[test]
#[should_panic(expected: 'AMOUNT_OVERFLOW')]
fn test_collected_amount_overflow() {
    let components = deploy_components();
    let token = components.token.contract_address();
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', 1);

    // Fund the dapp with `u128::MAX + 1` (two supplies, since `supply` takes a u128).
    let max = Bounded::<u128>::MAX;
    components.token.supply(address: components.mock_dapp, amount: max);
    components.token.supply(address: components.mock_dapp, amount: 1);

    // Two pay-outs add `u128::MAX + 1` to the sub-account, so the collected delta overflows u128.
    components
        .invoke(
            :identity_commitment,
            calls: array![
                transfer_to_caller_call(components.mock_dapp, token, max),
                transfer_to_caller_call(components.mock_dapp, token, 1),
            ],
            open_notes: array![OpenNote { note_id: NOTE_ID, token }].span(),
        );
}

/// Deploys the sub-account for `('USER', 'DAPP', nonce)` via an empty invoke.
fn deploy_nonce(components: Components, nonce: u64) {
    let identity_commitment = anonymizer_disp(components.anonymizer)
        .privacy_compute('USER', 'DAPP', nonce.into());
    components.invoke(:identity_commitment, calls: array![], open_notes: array![].span());
}

#[test]
fn test_get_sub_accounts_resolves_deployed_and_undeployed() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let partial = partial_commitment('USER', 'DAPP');
    deploy_nonce(components, 0);
    deploy_nonce(components, 1);

    // Nonce 2 is undeployed; the view resolves every nonce in range with an is_deployed flag.
    let infos = anonymizer.get_sub_accounts(partial, 0, 3);
    assert_eq!(infos.len(), 3);
    assert_eq!((*infos[0]).nonce, 0);
    assert!((*infos[0]).is_deployed);
    assert!((*infos[1]).is_deployed);
    let undeployed = *infos[2];
    assert_eq!(undeployed.nonce, 2);
    assert!(!undeployed.is_deployed);
    // Even undeployed, it resolves to the deterministic address it would deploy to.
    assert!(undeployed.address.is_non_zero());
}

#[test]
fn test_get_sub_accounts_computed_address_matches_deploy() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let partial = partial_commitment('USER', 'DAPP');

    let before = *anonymizer.get_sub_accounts(partial, 0, 1)[0];
    assert!(!before.is_deployed);
    deploy_nonce(components, 0);
    let after = *anonymizer.get_sub_accounts(partial, 0, 1)[0];
    assert!(after.is_deployed);
    // The address computed before deployment matches the actual on-chain deploy address.
    assert_eq!(before.address, after.address);
}

#[test]
fn test_get_sub_accounts_scopes_by_dapp_and_nonce() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let dapp = anonymizer.get_sub_accounts(partial_commitment('USER', 'DAPP'), 0, 2);
    let nonce0 = *dapp[0];
    let nonce1 = *dapp[1];
    let other_dapp = *anonymizer.get_sub_accounts(partial_commitment('USER', 'OTHER'), 0, 1)[0];
    assert!(nonce0.address != nonce1.address);
    assert!(nonce0.address != other_dapp.address);
}

#[test]
fn test_get_sub_accounts_from_start_nonce() {
    let components = deploy_components();
    let anonymizer = anonymizer_disp(components.anonymizer);
    let partial = partial_commitment('USER', 'DAPP');
    deploy_nonce(components, 0);
    deploy_nonce(components, 1);

    // Scanning from nonce 1 skips nonce 0; entries carry their own nonce.
    let infos = anonymizer.get_sub_accounts(partial, 1, 3);
    assert_eq!(infos.len(), 2);
    assert_eq!((*infos[0]).nonce, 1);
    assert!((*infos[0]).is_deployed);
    assert_eq!((*infos[1]).nonce, 2);
    assert!(!(*infos[1]).is_deployed);
}

#[test]
fn test_get_sub_accounts_empty_range() {
    let components = deploy_components();
    let infos = anonymizer_disp(components.anonymizer)
        .get_sub_accounts(partial_commitment('USER', 'DAPP'), 5, 5);
    assert_eq!(infos.len(), 0);
}

#[test]
#[should_panic(expected: 'RANGE_TOO_LARGE')]
fn test_get_sub_accounts_range_too_large_reverts() {
    let components = deploy_components();
    anonymizer_disp(components.anonymizer)
        .get_sub_accounts(partial_commitment('USER', 'DAPP'), 0, MAX_SCAN_RANGE + 1);
}
