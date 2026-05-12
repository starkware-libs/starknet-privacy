use call_anonymizer::call_anonymizer::{
    CallAnonymizer, ICallAnonymizerDispatcher, ICallAnonymizerDispatcherTrait,
    ICallAnonymizerSafeDispatcher, ICallAnonymizerSafeDispatcherTrait,
};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{CustomToken, DeclareResultTrait, Token, TokenTrait, declare};
use starknet::account::Call;
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{
    Deployable, TokenConfig, TokenHelperTrait, assert_panic_with_felt_error,
};

const TRANSFER_AMOUNT: u128 = 1_000_000_000_000_000_000;

fn deploy_call_anonymizer() -> ContractAddress {
    let class_hash = declare(contract: "CallAnonymizer")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (address, _) = CallAnonymizer::deploy_for_test(class_hash: *class_hash, :deployment_params)
        .expect('CallAnonymizer deploy failed');
    address
}

fn deploy_test_erc20_token() -> Token {
    let config = TokenConfig {
        name: "CallAnonTestToken",
        symbol: "CAT",
        decimals: 18,
        initial_supply: 1_000_000_000_000_000_000_000_000_000_000_u256,
        owner: 'TOKEN_OWNER'.try_into().unwrap(),
    };
    let token = config.deploy();
    Token::Custom(
        CustomToken {
            contract_address: token.address,
            balances_variable_selector: selector!("ERC20_balances"),
        },
    )
}

fn transfer_call(token: ContractAddress, recipient: ContractAddress, amount: u128) -> Call {
    let mut calldata = ArrayTrait::new();
    let amount_u256: u256 = amount.into();
    Serde::serialize(@recipient, ref calldata);
    Serde::serialize(@amount_u256, ref calldata);
    Call { to: token, selector: selector!("transfer"), calldata: calldata.span() }
}

#[test]
fn test_empty_calls_returns_empty_span() {
    let anonymizer = deploy_call_anonymizer();
    let deposits = ICallAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(calls: ArrayTrait::new());
    assert_eq!(deposits.len(), 0);
}

#[test]
fn test_dispatches_single_call() {
    // Funds the anonymizer, then calls privacy_invoke with a single transfer call to verify the
    // call is actually dispatched via syscall (anonymizer is the caller of `transfer`).
    let anonymizer = deploy_call_anonymizer();
    let token = deploy_test_erc20_token();
    let recipient: ContractAddress = 'RECIPIENT'.try_into().unwrap();
    token.supply(address: anonymizer, amount: TRANSFER_AMOUNT);

    let calls = array![transfer_call(token.contract_address(), recipient, TRANSFER_AMOUNT)];
    let deposits = ICallAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(:calls);

    assert_eq!(deposits.len(), 0);
    assert_eq!(token.balance_of(address: anonymizer), 0);
    assert_eq!(token.balance_of(address: recipient), TRANSFER_AMOUNT.into());
}

#[test]
fn test_dispatches_multiple_calls_in_order() {
    // Two sequential transfers to two distinct recipients verify ordered dispatch.
    let anonymizer = deploy_call_anonymizer();
    let token = deploy_test_erc20_token();
    let recipient_a: ContractAddress = 'RECIPIENT_A'.try_into().unwrap();
    let recipient_b: ContractAddress = 'RECIPIENT_B'.try_into().unwrap();
    token.supply(address: anonymizer, amount: TRANSFER_AMOUNT * 3);

    let calls = array![
        transfer_call(token.contract_address(), recipient_a, TRANSFER_AMOUNT),
        transfer_call(token.contract_address(), recipient_b, TRANSFER_AMOUNT * 2),
    ];
    ICallAnonymizerDispatcher { contract_address: anonymizer }.privacy_invoke(:calls);

    assert_eq!(token.balance_of(address: anonymizer), 0);
    assert_eq!(token.balance_of(address: recipient_a), TRANSFER_AMOUNT.into());
    assert_eq!(token.balance_of(address: recipient_b), (TRANSFER_AMOUNT * 2).into());
}

#[test]
#[feature("safe_dispatcher")]
fn test_inner_call_revert_propagates() {
    // Anonymizer is unfunded; the transfer call inside privacy_invoke must revert and bubble up
    // to the caller, leaving balances untouched.
    let anonymizer = deploy_call_anonymizer();
    let token = deploy_test_erc20_token();
    let recipient: ContractAddress = 'RECIPIENT'.try_into().unwrap();

    let calls = array![transfer_call(token.contract_address(), recipient, TRANSFER_AMOUNT)];
    let result = ICallAnonymizerSafeDispatcher { contract_address: anonymizer }
        .privacy_invoke(:calls);
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');

    // Confirm no partial state mutation.
    let token_dispatcher = IERC20Dispatcher { contract_address: token.contract_address() };
    assert_eq!(token_dispatcher.balance_of(account: recipient), 0_u256);
}

#[test]
#[feature("safe_dispatcher")]
fn test_revert_in_middle_call_reverts_whole_dispatch() {
    // First transfer would succeed in isolation, but the second one over-spends. Cairo execution
    // is atomic per entry-point: the whole privacy_invoke must revert and leave the balance of
    // recipient_a at zero.
    let anonymizer = deploy_call_anonymizer();
    let token = deploy_test_erc20_token();
    let recipient_a: ContractAddress = 'RECIPIENT_A'.try_into().unwrap();
    let recipient_b: ContractAddress = 'RECIPIENT_B'.try_into().unwrap();
    token.supply(address: anonymizer, amount: TRANSFER_AMOUNT);

    let calls = array![
        transfer_call(token.contract_address(), recipient_a, TRANSFER_AMOUNT),
        // anonymizer only has TRANSFER_AMOUNT, so this second call must revert
        transfer_call(token.contract_address(), recipient_b, TRANSFER_AMOUNT),
    ];
    let result = ICallAnonymizerSafeDispatcher { contract_address: anonymizer }
        .privacy_invoke(:calls);
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');

    let token_dispatcher = IERC20Dispatcher { contract_address: token.contract_address() };
    assert_eq!(token_dispatcher.balance_of(account: recipient_a), 0_u256);
    assert_eq!(token_dispatcher.balance_of(account: recipient_b), 0_u256);
    assert_eq!(token_dispatcher.balance_of(account: anonymizer), TRANSFER_AMOUNT.into());
}
