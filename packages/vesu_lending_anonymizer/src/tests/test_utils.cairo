use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::objects::OpenNoteDeposit;
use snforge_std::{CustomToken, DeclareResultTrait, Token, TokenTrait, declare};
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{Deployable, TokenConfig, cheat_caller_address_once};

/// Trusted privacy contract used by the anonymizer in tests. `privacy_invoke` rejects any other
/// caller, so the wrappers below cheat the caller to this address.
pub fn privacy_contract() -> ContractAddress {
    'PRIVACY_CONTRACT'.try_into().unwrap()
}
use vesu_lending_anonymizer::test_utils_contracts::mock_vesu_vault::MockVesuVault::deploy_for_test as deploy_mock_vesu_vault_for_test;
use vesu_lending_anonymizer::test_utils_contracts::mock_vesu_vault::MockVesuVaultNoop::deploy_for_test as deploy_mock_vesu_vault_noop_for_test;
use vesu_lending_anonymizer::test_utils_contracts::mock_vesu_vault::MockVesuVaultOverflow::deploy_for_test as deploy_mock_vesu_vault_overflow_for_test;
use vesu_lending_anonymizer::vesu_lending_anonymizer::{
    IVesuLendingAnonymizerDispatcher, IVesuLendingAnonymizerDispatcherTrait,
    IVesuLendingAnonymizerSafeDispatcher, IVesuLendingAnonymizerSafeDispatcherTrait,
    LendingOperation, VesuLendingAnonymizer,
};

#[derive(Drop, Copy)]
pub struct Vesu {
    pub underlying_token: Token,
    pub vault: ContractAddress,
    pub lending_anonymizer: ContractAddress,
    /// The privacy contract the anonymizer trusts; the wrappers cheat the caller to this address.
    pub privacy_address: ContractAddress,
}

#[generate_trait]
pub impl VesuImpl of VesuTrait {
    fn privacy_invoke_deposit(
        self: @Vesu, amount: u128, note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        self.cheat_privacy_caller();
        IVesuLendingAnonymizerDispatcher { contract_address: *self.lending_anonymizer }
            .privacy_invoke(
                operation: LendingOperation::Deposit,
                in_token: self.underlying_token.contract_address(),
                out_token: *self.vault,
                assets: amount.into(),
                :note_id,
            )
    }

    fn privacy_invoke_withdraw(
        self: @Vesu, amount: u128, note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        self.cheat_privacy_caller();
        IVesuLendingAnonymizerDispatcher { contract_address: *self.lending_anonymizer }
            .privacy_invoke(
                operation: LendingOperation::Withdraw,
                in_token: *self.vault,
                out_token: self.underlying_token.contract_address(),
                assets: amount.into(),
                :note_id,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_deposit(
        self: @Vesu, amount: u128, note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        self.cheat_privacy_caller();
        IVesuLendingAnonymizerSafeDispatcher { contract_address: *self.lending_anonymizer }
            .privacy_invoke(
                operation: LendingOperation::Deposit,
                in_token: self.underlying_token.contract_address(),
                out_token: *self.vault,
                assets: amount.into(),
                :note_id,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_withdraw(
        self: @Vesu, amount: u128, note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        self.cheat_privacy_caller();
        IVesuLendingAnonymizerSafeDispatcher { contract_address: *self.lending_anonymizer }
            .privacy_invoke(
                operation: LendingOperation::Withdraw,
                in_token: *self.vault,
                out_token: self.underlying_token.contract_address(),
                assets: amount.into(),
                :note_id,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke(
        self: @Vesu,
        operation: LendingOperation,
        in_token: ContractAddress,
        out_token: ContractAddress,
        assets: u128,
        note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        self.cheat_privacy_caller();
        IVesuLendingAnonymizerSafeDispatcher { contract_address: *self.lending_anonymizer }
            .privacy_invoke(:operation, :in_token, :out_token, assets: assets.into(), :note_id)
    }

    /// Calls `privacy_invoke` from `caller` (no cheat to the trusted privacy address), used to
    /// exercise the caller-authorization guard.
    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_from(
        self: @Vesu, caller: ContractAddress, amount: u128, note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        cheat_caller_address_once(
            contract_address: *self.lending_anonymizer, caller_address: caller,
        );
        IVesuLendingAnonymizerSafeDispatcher { contract_address: *self.lending_anonymizer }
            .privacy_invoke(
                operation: LendingOperation::Deposit,
                in_token: self.underlying_token.contract_address(),
                out_token: *self.vault,
                assets: amount.into(),
                :note_id,
            )
    }

    fn cheat_privacy_caller(self: @Vesu) {
        cheat_caller_address_once(
            contract_address: *self.lending_anonymizer, caller_address: *self.privacy_address,
        );
    }

    fn vault_balance_of(self: @Vesu, address: ContractAddress) -> u256 {
        IERC20Dispatcher { contract_address: *self.vault }.balance_of(account: address)
    }
}

pub fn deploy_vesu_components() -> Vesu {
    let underlying_token = deploy_test_erc20_token();
    let vault = deploy_mock_vesu_vault(underlying_token: underlying_token.contract_address());
    let privacy_address = privacy_contract();
    let lending_anonymizer = deploy_vesu_lending_anonymizer(privacy_contract: privacy_address);
    Vesu { underlying_token, vault, lending_anonymizer, privacy_address }
}

pub fn deploy_vesu_lending_anonymizer(privacy_contract: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "VesuLendingAnonymizer")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (address, _) = VesuLendingAnonymizer::deploy_for_test(
        class_hash: *class_hash, :deployment_params, :privacy_contract,
    )
        .expect('VesuLending deploy failed');
    address
}

fn deploy_mock_vesu_vault(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockVesuVault")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_vesu_vault_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockVesuVault",
        symbol: "MV",
        :underlying_token,
    )
        .expect('MockVesuVault deploy failed');
    address
}

pub fn deploy_mock_vesu_vault_noop(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockVesuVaultNoop")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_vesu_vault_noop_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockVesuVaultNoop",
        symbol: "MVN",
        :underlying_token,
    )
        .expect('MockVesuVaultNoop deploy failed');
    address
}

pub fn deploy_mock_vesu_vault_overflow(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockVesuVaultOverflow")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_vesu_vault_overflow_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockVesuVaultOverflow",
        symbol: "MVO",
        :underlying_token,
    )
        .expect('MockVesuVaultOverflow failed');
    address
}

fn deploy_test_erc20_token() -> Token {
    let config = TokenConfig {
        name: "VesuTestToken",
        symbol: "VTT",
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
