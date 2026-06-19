use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::objects::OpenNoteDeposit;
use snforge_std::{ContractClassTrait, CustomToken, DeclareResultTrait, Token, TokenTrait, declare};
use starknet::account::Call;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{Deployable, TokenConfig, cheat_caller_address_once};
use sub_account_anonymizer::sub_account_anonymizer::{
    ISubAccountAnonymizerDispatcher, ISubAccountAnonymizerDispatcherTrait,
};

/// The address configured as the privacy contract; the only authorized caller.
pub const PRIVACY: ContractAddress = 'PRIVACY'.try_into().unwrap();

pub fn anonymizer_disp(anonymizer: ContractAddress) -> ISubAccountAnonymizerDispatcher {
    ISubAccountAnonymizerDispatcher { contract_address: anonymizer }
}

/// A deployed anonymizer together with a funding-capable token and a mock dapp, for exercising the
/// full invoke-and-sweep flow.
#[derive(Drop, Copy)]
pub struct Components {
    pub token: Token,
    pub mock_dapp: ContractAddress,
    pub anonymizer: ContractAddress,
}

#[generate_trait]
pub impl ComponentsImpl of ComponentsTrait {
    /// Calls `privacy_invoke_with_computation` cheating the caller to be the privacy contract.
    fn invoke(
        self: @Components,
        commitment: felt252,
        invokes: Span<Call>,
        open_notes: Span<(felt252, ContractAddress)>,
    ) -> Span<OpenNoteDeposit> {
        cheat_caller_address_once(contract_address: *self.anonymizer, caller_address: PRIVACY);
        anonymizer_disp(*self.anonymizer)
            .privacy_invoke_with_computation(:commitment, :invokes, :open_notes)
    }

    fn token_address(self: @Components) -> ContractAddress {
        self.token.contract_address()
    }

    fn balance_of(self: @Components, address: ContractAddress) -> u256 {
        IERC20Dispatcher { contract_address: self.token.contract_address() }
            .balance_of(account: address)
    }

    fn allowance(self: @Components, owner: ContractAddress, spender: ContractAddress) -> u256 {
        IERC20Dispatcher { contract_address: self.token.contract_address() }
            .allowance(:owner, :spender)
    }
}

pub fn deploy_components() -> Components {
    let token = deploy_test_erc20_token();
    let mock_dapp = deploy_mock_dapp();
    let anonymizer = deploy_sub_account_anonymizer();
    Components { token, mock_dapp, anonymizer }
}

/// Builds a `pay_out(token, amount)` call on the mock dapp, which transfers `amount` to its caller.
pub fn pay_out_call(mock_dapp: ContractAddress, token: ContractAddress, amount: u128) -> Call {
    Call {
        to: mock_dapp,
        selector: selector!("pay_out"),
        calldata: array![token.into(), amount.into(), 0].span(),
    }
}

pub fn deploy_sub_account_anonymizer() -> ContractAddress {
    let sub_account_class_hash = *declare("SubAccount")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let contract = declare("SubAccountAnonymizer").unwrap_syscall().contract_class();
    let (address, _) = contract
        .deploy(@array![PRIVACY.into(), sub_account_class_hash.into()])
        .unwrap_syscall();
    address
}

fn deploy_test_erc20_token() -> Token {
    let config = TokenConfig {
        name: "SubAccTestToken",
        symbol: "SAT",
        decimals: 18,
        initial_supply: 1_000_000_000_000_000_000_000_000_u256,
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

fn deploy_mock_dapp() -> ContractAddress {
    let contract = declare("MockDapp").unwrap_syscall().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap_syscall();
    address
}
