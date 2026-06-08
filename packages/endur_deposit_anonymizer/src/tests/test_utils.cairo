use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::objects::OpenNoteDeposit;
use snforge_std::{CustomToken, DeclareResultTrait, Token, TokenTrait, declare};
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{Deployable, TokenConfig};
use endur_deposit_anonymizer::test_utils_contracts::mock_endur_vault::MockEndurVault::deploy_for_test as deploy_mock_endur_vault_for_test;
use endur_deposit_anonymizer::test_utils_contracts::mock_endur_vault::MockEndurVaultNoop::deploy_for_test as deploy_mock_endur_vault_noop_for_test;
use endur_deposit_anonymizer::test_utils_contracts::mock_endur_vault::MockEndurVaultOverflow::deploy_for_test as deploy_mock_endur_vault_overflow_for_test;
use endur_deposit_anonymizer::endur_deposit_anonymizer::{
    EndurDepositAnonymizer, IEndurDepositAnonymizerDispatcher,
    IEndurDepositAnonymizerDispatcherTrait, IEndurDepositAnonymizerSafeDispatcher,
    IEndurDepositAnonymizerSafeDispatcherTrait,
};

#[derive(Drop, Copy)]
pub struct Endur {
    pub underlying_token: Token,
    pub vault: ContractAddress,
    pub deposit_anonymizer: ContractAddress,
}

#[generate_trait]
pub impl EndurImpl of EndurTrait {
    fn privacy_invoke_deposit(
        self: @Endur, amount: u128, note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        IEndurDepositAnonymizerDispatcher { contract_address: *self.deposit_anonymizer }
            .privacy_invoke(
                in_token: self.underlying_token.contract_address(),
                out_token: *self.vault,
                assets: amount.into(),
                :note_id,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_deposit(
        self: @Endur, amount: u128, note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        IEndurDepositAnonymizerSafeDispatcher { contract_address: *self.deposit_anonymizer }
            .privacy_invoke(
                in_token: self.underlying_token.contract_address(),
                out_token: *self.vault,
                assets: amount.into(),
                :note_id,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke(
        self: @Endur,
        in_token: ContractAddress,
        out_token: ContractAddress,
        assets: u128,
        note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        IEndurDepositAnonymizerSafeDispatcher { contract_address: *self.deposit_anonymizer }
            .privacy_invoke(:in_token, :out_token, assets: assets.into(), :note_id)
    }

    fn vault_balance_of(self: @Endur, address: ContractAddress) -> u256 {
        IERC20Dispatcher { contract_address: *self.vault }.balance_of(account: address)
    }
}

pub fn deploy_endur_components() -> Endur {
    let underlying_token = deploy_test_erc20_token();
    let vault = deploy_mock_endur_vault(underlying_token: underlying_token.contract_address());
    let deposit_anonymizer = deploy_endur_deposit_anonymizer();
    Endur { underlying_token, vault, deposit_anonymizer }
}

pub fn deploy_endur_deposit_anonymizer() -> ContractAddress {
    let class_hash = declare(contract: "EndurDepositAnonymizer")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (address, _) = EndurDepositAnonymizer::deploy_for_test(
        class_hash: *class_hash, :deployment_params,
    )
        .expect('EndurDeposit deploy failed');
    address
}

fn deploy_mock_endur_vault(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockEndurVault")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_endur_vault_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockEndurVault",
        symbol: "xSTRK",
        :underlying_token,
    )
        .expect('MockEndurVault deploy failed');
    address
}

pub fn deploy_mock_endur_vault_noop(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockEndurVaultNoop")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_endur_vault_noop_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockEndurVaultNoop",
        symbol: "xSTRK",
        :underlying_token,
    )
        .expect('MockEndurVaultNoop failed');
    address
}

pub fn deploy_mock_endur_vault_overflow(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockEndurVaultOverflow")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_endur_vault_overflow_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockEndurVaultOverflow",
        symbol: "xSTRK",
        :underlying_token,
    )
        .expect('MockEndurVaultOverflow failed');
    address
}

fn deploy_test_erc20_token() -> Token {
    let config = TokenConfig {
        name: "EndurTestToken",
        symbol: "ETT",
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
