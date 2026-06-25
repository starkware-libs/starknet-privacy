use privacy::objects::OpenNoteDeposit;
use snforge_std::{ContractClassTrait, DeclareResultTrait, Token, declare};
use starknet::account::Call;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{cheat_caller_address_once, deploy_mock_erc20_token};
use sub_account_anonymizer::sub_account_anonymizer::{
    ISubAccountAnonymizerDispatcher, ISubAccountAnonymizerDispatcherTrait, OpenNote,
};

/// The address configured as the privacy contract; the only authorized caller.
pub const PRIVACY: ContractAddress = 'PRIVACY'.try_into().unwrap();

/// The address configured as the governance admin; authorized to manage roles and upgrades.
pub const GOVERNANCE_ADMIN: ContractAddress = 'GOVERNANCE_ADMIN'.try_into().unwrap();

pub fn anonymizer_disp(anonymizer: ContractAddress) -> ISubAccountAnonymizerDispatcher {
    ISubAccountAnonymizerDispatcher { contract_address: anonymizer }
}

/// A deployed anonymizer together with a funding-capable token and a mock dapp, for exercising the
/// full invoke-and-collect flow.
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
        identity_commitment: felt252,
        calls: Array<Call>,
        open_notes: Span<OpenNote>,
    ) -> Span<OpenNoteDeposit> {
        cheat_caller_address_once(contract_address: *self.anonymizer, caller_address: PRIVACY);
        anonymizer_disp(*self.anonymizer)
            .privacy_invoke_with_computation(:identity_commitment, :calls, :open_notes)
    }
}

pub fn deploy_components() -> Components {
    let token = deploy_token();
    let mock_dapp = deploy_mock_dapp();
    let anonymizer = deploy_sub_account_anonymizer();
    Components { token, mock_dapp, anonymizer }
}

/// Builds a `transfer_to_caller(token, amount)` call on the mock dapp, which transfers `amount` to
/// its caller.
pub fn transfer_to_caller_call(
    mock_dapp: ContractAddress, token: ContractAddress, amount: u128,
) -> Call {
    Call {
        to: mock_dapp,
        selector: selector!("transfer_to_caller"),
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
        .deploy(@array![PRIVACY.into(), sub_account_class_hash.into(), GOVERNANCE_ADMIN.into()])
        .unwrap_syscall();
    address
}

pub fn deploy_token() -> Token {
    // Snforge deploys each contract to a fresh address per deploy() call regardless of identical
    // class/calldata.
    deploy_mock_erc20_token(
        name: "SubAccTestToken",
        symbol: "SAT",
        decimals: 18,
        initial_supply: 1_000_000_000_000_000_000_000_000_u256,
        owner: 'TOKEN_OWNER'.try_into().unwrap(),
    )
}

fn deploy_mock_dapp() -> ContractAddress {
    let contract = declare("MockDapp").unwrap_syscall().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap_syscall();
    address
}
