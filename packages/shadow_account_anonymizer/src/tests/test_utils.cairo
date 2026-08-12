use privacy::objects::OpenNoteDeposit;
use shadow_account_anonymizer::shadow_account_anonymizer::{
    IShadowAccountAnonymizerDispatcher, IShadowAccountAnonymizerDispatcherTrait, OpenNote,
};
use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, Token, cheat_block_timestamp,
    cheat_caller_address, declare, get_class_hash, stop_cheat_block_timestamp,
    stop_cheat_caller_address,
};
use starknet::account::Call;
use starknet::{ClassHash, ContractAddress, SyscallResultTrait};
use starkware_utils::components::replaceability::interface::{
    EICData, IReplaceableDispatcher, IReplaceableDispatcherTrait, ImplementationData,
};
use starkware_utils::components::roles::interface::{
    ICommonRolesDispatcher, ICommonRolesDispatcherTrait, Role,
};
use starkware_utils_testing::test_utils::{cheat_caller_address_once, deploy_mock_erc20_token};

/// The address configured as the privacy contract; the only authorized caller.
pub const PRIVACY: ContractAddress = 'PRIVACY'.try_into().unwrap();

/// The address configured as the governance admin; authorized to manage roles and upgrades.
pub const GOVERNANCE_ADMIN: ContractAddress = 'GOVERNANCE_ADMIN'.try_into().unwrap();

/// The address granted the upgrade governor role, which runs the EIC-carrying upgrades.
pub const UPGRADE_GOVERNOR: ContractAddress = 'UPGRADE_GOVERNOR'.try_into().unwrap();

/// A timestamp to run upgrades at: the replaceability component reads a zero activation time as
/// "implementation was never added", and the anonymizer's upgrade delay is zero.
const UPGRADE_TIME: u64 = 1000;

pub fn anonymizer_disp(anonymizer: ContractAddress) -> IShadowAccountAnonymizerDispatcher {
    IShadowAccountAnonymizerDispatcher { contract_address: anonymizer }
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
    let anonymizer = deploy_shadow_account_anonymizer();
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

pub fn deploy_shadow_account_anonymizer() -> ContractAddress {
    deploy_anonymizer_with_shadow_account_class(
        shadow_account_class_hash: declare_class("SubAccount"),
    )
}

/// Deploys an anonymizer that deploys its shadow accounts with `shadow_account_class_hash`.
pub fn deploy_anonymizer_with_shadow_account_class(
    shadow_account_class_hash: ClassHash,
) -> ContractAddress {
    let contract = declare("ShadowAccountAnonymizer").unwrap_syscall().contract_class();
    let (address, _) = contract
        .deploy(@array![PRIVACY.into(), shadow_account_class_hash.into(), GOVERNANCE_ADMIN.into()])
        .unwrap_syscall();
    address
}

pub fn declare_class(contract_name: ByteArray) -> ClassHash {
    *declare(contract_name).unwrap_syscall().contract_class().class_hash
}

/// Runs `eic_name` against `anonymizer` the way it runs in production: an upgrade to the
/// anonymizer's own class with the EIC attached, driven by an upgrade governor.
pub fn run_eic_upgrade(
    anonymizer: ContractAddress, eic_name: ByteArray, eic_init_data: Span<felt252>,
) {
    cheat_caller_address_once(contract_address: anonymizer, caller_address: GOVERNANCE_ADMIN);
    ICommonRolesDispatcher { contract_address: anonymizer }
        .grant_role(role: Role::UpgradeGovernor, account: UPGRADE_GOVERNOR);

    let implementation_data = ImplementationData {
        impl_hash: get_class_hash(anonymizer),
        eic_data: Some(EICData { eic_hash: declare_class(eic_name), eic_init_data }),
        final: false,
    };
    let replaceable = IReplaceableDispatcher { contract_address: anonymizer };
    cheat_block_timestamp(anonymizer, UPGRADE_TIME, CheatSpan::Indefinite);
    cheat_caller_address(
        contract_address: anonymizer, caller_address: UPGRADE_GOVERNOR, span: CheatSpan::Indefinite,
    );
    replaceable.add_new_implementation(:implementation_data);
    replaceable.replace_to(:implementation_data);
    stop_cheat_caller_address(anonymizer);
    stop_cheat_block_timestamp(anonymizer);
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
