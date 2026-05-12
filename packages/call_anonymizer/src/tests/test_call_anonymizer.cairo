use call_anonymizer::call_anonymizer::{
    CallAnonymizer, ICallAnonymizerDispatcher, ICallAnonymizerDispatcherTrait,
    ICallAnonymizerSafeDispatcher, ICallAnonymizerSafeDispatcherTrait,
};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::objects::OpenNoteDeposit;
use snforge_std::{CustomToken, DeclareResultTrait, Token, TokenTrait, declare};
use starknet::account::Call;
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{
    Deployable, TokenConfig, TokenHelperTrait, assert_panic_with_felt_error,
};

const TRANSFER_AMOUNT: u128 = 1_000_000_000_000_000_000;
const DEFAULT_NOTE_ID: felt252 = 'NOTE_ID';

fn deploy_call_anonymizer() -> ContractAddress {
    let class_hash = declare(contract: "CallAnonymizer")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (address, _) = CallAnonymizer::deploy_for_test(
        class_hash: *class_hash, :deployment_params,
    )
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

fn deposit(token: ContractAddress, amount: u128) -> OpenNoteDeposit {
    OpenNoteDeposit { note_id: DEFAULT_NOTE_ID, token, amount }
}

#[test]
fn test_empty_calls_returns_empty_deposits() {
    let anonymizer = deploy_call_anonymizer();
    let deposits = ICallAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(calls: ArrayTrait::new(), deposits: ArrayTrait::new());
    assert_eq!(deposits.len(), 0);
}

#[test]
fn test_empty_calls_passes_deposits_through() {
    // No calls but non-empty deposits: the contract is purely a passthrough for the deposit
    // span and does no validation of its own. The pool would later reject this in practice
    // (no funds to transferFrom), but at the contract layer there is no precondition.
    let anonymizer = deploy_call_anonymizer();
    let token = deploy_test_erc20_token();
    let expected = deposit(token.contract_address(), TRANSFER_AMOUNT);
    let result = ICallAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(calls: ArrayTrait::new(), deposits: array![expected]);
    assert_eq!(result.len(), 1);
    assert_eq!(*result[0], expected);
}

#[test]
fn test_dispatches_single_call_then_returns_deposits() {
    // Funds the anonymizer, then privacy_invoke runs a transfer call to a third party and
    // returns the deposits unchanged.
    let anonymizer = deploy_call_anonymizer();
    let token = deploy_test_erc20_token();
    let recipient: ContractAddress = 'RECIPIENT'.try_into().unwrap();
    token.supply(address: anonymizer, amount: TRANSFER_AMOUNT);

    let calls = array![transfer_call(token.contract_address(), recipient, TRANSFER_AMOUNT)];
    let deposits = array![deposit(token.contract_address(), TRANSFER_AMOUNT)];
    let result = ICallAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(:calls, :deposits);

    assert_eq!(result.len(), 1);
    assert_eq!(*result[0], deposit(token.contract_address(), TRANSFER_AMOUNT));
    assert_eq!(token.balance_of(address: anonymizer), 0);
    assert_eq!(token.balance_of(address: recipient), TRANSFER_AMOUNT.into());
}

#[test]
fn test_dispatches_multiple_calls_in_order() {
    // Two sequential transfers verify ordered dispatch; deposits are returned as supplied.
    let anonymizer = deploy_call_anonymizer();
    let token = deploy_test_erc20_token();
    let recipient_a: ContractAddress = 'RECIPIENT_A'.try_into().unwrap();
    let recipient_b: ContractAddress = 'RECIPIENT_B'.try_into().unwrap();
    token.supply(address: anonymizer, amount: TRANSFER_AMOUNT * 3);

    let calls = array![
        transfer_call(token.contract_address(), recipient_a, TRANSFER_AMOUNT),
        transfer_call(token.contract_address(), recipient_b, TRANSFER_AMOUNT * 2),
    ];
    let deposits = array![deposit(token.contract_address(), TRANSFER_AMOUNT)];
    let result = ICallAnonymizerDispatcher { contract_address: anonymizer }
        .privacy_invoke(:calls, :deposits);

    assert_eq!(result.len(), 1);
    assert_eq!(token.balance_of(address: anonymizer), 0);
    assert_eq!(token.balance_of(address: recipient_a), TRANSFER_AMOUNT.into());
    assert_eq!(token.balance_of(address: recipient_b), (TRANSFER_AMOUNT * 2).into());
}

#[test]
#[feature("safe_dispatcher")]
fn test_inner_call_revert_propagates() {
    // Anonymizer is unfunded; the transfer call inside privacy_invoke must revert. Deposits are
    // never returned (the syscall propagates up before the return).
    let anonymizer = deploy_call_anonymizer();
    let token = deploy_test_erc20_token();
    let recipient: ContractAddress = 'RECIPIENT'.try_into().unwrap();

    let calls = array![transfer_call(token.contract_address(), recipient, TRANSFER_AMOUNT)];
    let deposits = array![deposit(token.contract_address(), TRANSFER_AMOUNT)];
    let result = ICallAnonymizerSafeDispatcher { contract_address: anonymizer }
        .privacy_invoke(:calls, :deposits);
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');

    let token_dispatcher = IERC20Dispatcher { contract_address: token.contract_address() };
    assert_eq!(token_dispatcher.balance_of(account: recipient), 0_u256);
}

#[test]
#[feature("safe_dispatcher")]
fn test_revert_in_middle_call_reverts_whole_dispatch() {
    // First transfer would succeed in isolation, but the second one over-spends. Cairo execution
    // is atomic per entry-point: the whole privacy_invoke must revert, leaving recipient_a at
    // zero.
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
    let deposits = array![deposit(token.contract_address(), TRANSFER_AMOUNT)];
    let result = ICallAnonymizerSafeDispatcher { contract_address: anonymizer }
        .privacy_invoke(:calls, :deposits);
    assert_panic_with_felt_error(:result, expected_error: 'ERC20: insufficient balance');

    let token_dispatcher = IERC20Dispatcher { contract_address: token.contract_address() };
    assert_eq!(token_dispatcher.balance_of(account: recipient_a), 0_u256);
    assert_eq!(token_dispatcher.balance_of(account: recipient_b), 0_u256);
    assert_eq!(token_dispatcher.balance_of(account: anonymizer), TRANSFER_AMOUNT.into());
}
