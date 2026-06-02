use forge_yields_anonymizer::forge_yields_anonymizer::{
    ClaimRedeemParams, DepositParams, ForgeOperation, ForgeYieldsAnonymizer,
    IForgeYieldsAnonymizerDispatcher, IForgeYieldsAnonymizerDispatcherTrait,
    IForgeYieldsAnonymizerSafeDispatcher, IForgeYieldsAnonymizerSafeDispatcherTrait,
    RequestRedeemParams,
};
use forge_yields_anonymizer::test_utils_contracts::mock_forge_gateway::MockForgeGateway::deploy_for_test as deploy_mock_forge_gateway_for_test;
use forge_yields_anonymizer::test_utils_contracts::mock_forge_gateway::MockForgeGatewayNoop::deploy_for_test as deploy_mock_forge_gateway_noop_for_test;
use forge_yields_anonymizer::test_utils_contracts::mock_forge_gateway::MockForgeGatewayOverflow::deploy_for_test as deploy_mock_forge_gateway_overflow_for_test;
use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::objects::OpenNoteDeposit;
use snforge_std::{CustomToken, DeclareResultTrait, Token, TokenTrait, declare};
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{Deployable, TokenConfig};

#[derive(Drop, Copy)]
pub struct Forge {
    pub underlying_token: Token,
    pub gateway: ContractAddress,
    pub anonymizer: ContractAddress,
}

#[generate_trait]
pub impl ForgeImpl of ForgeTrait {
    fn privacy_invoke_deposit(
        self: @Forge, amount: u128, note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        IForgeYieldsAnonymizerDispatcher { contract_address: *self.anonymizer }
            .privacy_invoke(
                ForgeOperation::Deposit(
                    DepositParams {
                        gateway: *self.gateway,
                        underlying: self.underlying_token.contract_address(),
                        assets: amount.into(),
                        note_id,
                    },
                ),
            )
    }

    fn privacy_invoke_request_redeem(
        self: @Forge, shares: u128, commitment: felt252,
    ) -> Span<OpenNoteDeposit> {
        IForgeYieldsAnonymizerDispatcher { contract_address: *self.anonymizer }
            .privacy_invoke(
                ForgeOperation::RequestRedeem(
                    RequestRedeemParams {
                        gateway: *self.gateway, shares: shares.into(), commitment,
                    },
                ),
            )
    }

    fn privacy_invoke_claim_redeem(
        self: @Forge, redemption_id: u256, secret: felt252, note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        IForgeYieldsAnonymizerDispatcher { contract_address: *self.anonymizer }
            .privacy_invoke(
                ForgeOperation::ClaimRedeem(
                    ClaimRedeemParams {
                        gateway: *self.gateway,
                        redemption_id,
                        secret,
                        underlying: self.underlying_token.contract_address(),
                        note_id,
                    },
                ),
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_deposit(
        self: @Forge, amount: u128, note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        IForgeYieldsAnonymizerSafeDispatcher { contract_address: *self.anonymizer }
            .privacy_invoke(
                ForgeOperation::Deposit(
                    DepositParams {
                        gateway: *self.gateway,
                        underlying: self.underlying_token.contract_address(),
                        assets: amount.into(),
                        note_id,
                    },
                ),
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_request_redeem(
        self: @Forge, shares: u128, commitment: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        IForgeYieldsAnonymizerSafeDispatcher { contract_address: *self.anonymizer }
            .privacy_invoke(
                ForgeOperation::RequestRedeem(
                    RequestRedeemParams {
                        gateway: *self.gateway, shares: shares.into(), commitment,
                    },
                ),
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_claim_redeem(
        self: @Forge, redemption_id: u256, secret: felt252, note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        IForgeYieldsAnonymizerSafeDispatcher { contract_address: *self.anonymizer }
            .privacy_invoke(
                ForgeOperation::ClaimRedeem(
                    ClaimRedeemParams {
                        gateway: *self.gateway,
                        redemption_id,
                        secret,
                        underlying: self.underlying_token.contract_address(),
                        note_id,
                    },
                ),
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_deposit_custom(
        self: @Forge, params: DepositParams,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        IForgeYieldsAnonymizerSafeDispatcher { contract_address: *self.anonymizer }
            .privacy_invoke(ForgeOperation::Deposit(params))
    }

    fn gateway_balance_of(self: @Forge, address: ContractAddress) -> u256 {
        IERC20Dispatcher { contract_address: *self.gateway }.balance_of(account: address)
    }

    /// Simulate the ForgeYields auto-service (or any bot) calling `claim_redeem`
    /// directly on the gateway. Burns the NFT and transfers underlying to the
    /// NFT owner (= the anonymizer). After this the anonymizer's `_claim_redeem`
    /// can verify the burn and route the funds.
    fn external_gateway_claim(self: @Forge, redemption_id: u256) -> u256 {
        starknet::syscalls::call_contract_syscall(
            address: *self.gateway,
            entry_point_selector: selector!("claim_redeem"),
            calldata: array![redemption_id.low.into(), redemption_id.high.into()].span(),
        )
            .unwrap_syscall();
        // Best-effort: re-read the underlying balance delta to surface a number.
        // Tests that need the precise amount can read it themselves.
        0
    }
}

pub fn deploy_forge_components() -> Forge {
    let underlying_token = deploy_test_erc20_token();
    let gateway = deploy_mock_forge_gateway(underlying_token: underlying_token.contract_address());
    let anonymizer = deploy_forge_yields_anonymizer();
    Forge { underlying_token, gateway, anonymizer }
}

pub fn deploy_forge_yields_anonymizer() -> ContractAddress {
    let class_hash = declare(contract: "ForgeYieldsAnonymizer")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (address, _) = ForgeYieldsAnonymizer::deploy_for_test(
        class_hash: *class_hash, :deployment_params,
    )
        .expect('ForgeYieldsAnon deploy failed');
    address
}

fn deploy_mock_forge_gateway(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockForgeGateway")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_forge_gateway_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockForgeGateway",
        symbol: "MFG",
        :underlying_token,
    )
        .expect('MockForgeGateway deploy failed');
    address
}

pub fn deploy_mock_forge_gateway_noop(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockForgeGatewayNoop")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_forge_gateway_noop_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockForgeGatewayNoop",
        symbol: "MFGN",
        :underlying_token,
    )
        .expect('MockForgeGwNoop deploy failed');
    address
}

pub fn deploy_mock_forge_gateway_overflow(underlying_token: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "MockForgeGatewayOverflow")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 1, deploy_from_zero: true };
    let (address, _) = deploy_mock_forge_gateway_overflow_for_test(
        class_hash: *class_hash,
        :deployment_params,
        name: "MockForgeGatewayOverflow",
        symbol: "MFGO",
        :underlying_token,
    )
        .expect('MockForgeGwOverflow failed');
    address
}

fn deploy_test_erc20_token() -> Token {
    let config = TokenConfig {
        name: "ForgeTestToken",
        symbol: "FTT",
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
