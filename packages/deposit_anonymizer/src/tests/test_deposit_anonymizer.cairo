use deposit_anonymizer::deposit_anonymizer::{
    DepositAnonymizer, IDepositAnonymizerDispatcher, IDepositAnonymizerDispatcherTrait,
    IDepositAnonymizerSafeDispatcher, IDepositAnonymizerSafeDispatcherTrait,
};
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::objects::OpenNoteDeposit;
use snforge_std::{CustomToken, DeclareResultTrait, Token, TokenTrait, declare};
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{
    Deployable, TokenConfig, TokenHelperTrait, cheat_caller_address_once,
};

const TRANSFER_AMOUNT: u128 = 1_000_000_000_000_000_000;
const NOTE_ID: felt252 = 'NOTE_ID';

fn deploy_deposit_anonymizer() -> ContractAddress {
    let class_hash = declare(contract: "DepositAnonymizer")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (address, _) = DepositAnonymizer::deploy_for_test(
        class_hash: *class_hash, :deployment_params,
    )
        .expect('Anonymizer deploy failed');
    address
}

fn deploy_test_erc20_token() -> Token {
    let config = TokenConfig {
        name: "DepositAnonTestToken",
        symbol: "DAT",
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

#[test]
fn test_deposit_to_open_note_transfers_and_returns_deposit() {
    let anonymizer = deploy_deposit_anonymizer();
    let token = deploy_test_erc20_token();
    let account: ContractAddress = 'ACCOUNT_A'.try_into().unwrap();
    let token_addr = token.contract_address();

    token.supply(address: account, amount: TRANSFER_AMOUNT);
    cheat_caller_address_once(contract_address: token_addr, caller_address: account);
    IERC20Dispatcher { contract_address: token_addr }
        .approve(spender: anonymizer, amount: TRANSFER_AMOUNT.into());

    cheat_caller_address_once(contract_address: anonymizer, caller_address: account);
    let deposit = IDepositAnonymizerDispatcher { contract_address: anonymizer }
        .deposit_to_open_note(note_id: NOTE_ID, token: token_addr, amount: TRANSFER_AMOUNT);

    assert_eq!(
        deposit,
        OpenNoteDeposit { note_id: NOTE_ID, token: token_addr, amount: TRANSFER_AMOUNT },
    );
    assert_eq!(token.balance_of(address: account), 0);
    assert_eq!(token.balance_of(address: anonymizer), TRANSFER_AMOUNT.into());
}

#[test]
#[feature("safe_dispatcher")]
fn test_privacy_invoke_empty_calls_reverts() {
    let anonymizer = deploy_deposit_anonymizer();
    let result = IDepositAnonymizerSafeDispatcher { contract_address: anonymizer }
        .privacy_invoke(calls: ArrayTrait::new());
    assert!(result.is_err());
}
