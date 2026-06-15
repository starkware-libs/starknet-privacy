use core::num::traits::Zero;
use ekubo::interfaces::router::TokenAmount;
use ekubo::types::i129::i129;
use ekubo::types::keys::PoolKey;
use ekubo_swap_anonymizer::ekubo_swap_anonymizer::{
    EkuboSwapAnonymizer, IEkuboSwapAnonymizerDispatcher, IEkuboSwapAnonymizerDispatcherTrait,
    IEkuboSwapAnonymizerSafeDispatcher, IEkuboSwapAnonymizerSafeDispatcherTrait,
};
use ekubo_swap_anonymizer::test_utils_contracts::mock_ekubo_amm::MockEkuboAMM::deploy_for_test as deploy_mock_ekubo_amm_for_test;
use privacy::objects::OpenNoteDeposit;
use snforge_std::{CustomToken, DeclareResultTrait, Token, declare};
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{Deployable, TokenConfig, cheat_caller_address_once};

/// Trusted privacy contract used by the anonymizer in tests. `privacy_invoke` rejects any other
/// caller, so the wrappers below cheat the caller to this address.
pub fn privacy_contract() -> ContractAddress {
    'PRIVACY_CONTRACT'.try_into().unwrap()
}

pub fn deploy_mock_ekubo_amm() -> ContractAddress {
    let class_hash = declare(contract: "MockEkuboAMM").unwrap_syscall().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_ekubo_amm_for_test(
        class_hash: *class_hash, :deployment_params,
    )
        .expect('MockEkuboAMM deployment failed');
    contract_address
}

pub fn deploy_ekubo_swap_anonymizer(privacy_contract: ContractAddress) -> ContractAddress {
    let class_hash = declare(contract: "EkuboSwapAnonymizer")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = EkuboSwapAnonymizer::deploy_for_test(
        class_hash: *class_hash, :deployment_params, :privacy_contract,
    )
        .expect('EkuboSwap deploy failed');
    contract_address
}

/// Build a PoolKey for the given token pair with default fee/tick_spacing and zero extension.
/// Tokens are sorted so that token0 < token1 by address value, matching real Ekubo pool keys.
pub fn pool_key_for_tokens(token_a: ContractAddress, token_b: ContractAddress) -> PoolKey {
    let (token0, token1) = if token_a < token_b {
        (token_a, token_b)
    } else {
        (token_b, token_a)
    };
    PoolKey { token0, token1, fee: 0, tick_spacing: 1, extension: Zero::zero() }
}

pub fn new_token() -> Token {
    let config = TokenConfig {
        name: "TestToken",
        symbol: "TT",
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

pub fn make_token_amount(token: ContractAddress, amount: u128) -> TokenAmount {
    TokenAmount { token, amount: i129 { mag: amount, sign: false } }
}

#[derive(Copy, Drop)]
pub struct EkuboSwapAnonymizerCfg {
    pub address: ContractAddress,
    pub router: ContractAddress,
    /// The privacy contract the anonymizer trusts; the wrappers cheat the caller to this address.
    pub privacy_address: ContractAddress,
}

#[generate_trait]
pub impl EkuboSwapAnonymizerCfgImpl of EkuboSwapAnonymizerCfgTrait {
    fn privacy_invoke(
        self: @EkuboSwapAnonymizerCfg,
        token_amount: TokenAmount,
        pool_key: PoolKey,
        minimum_received: u256,
        skip_ahead: u128,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.privacy_address,
        );
        IEkuboSwapAnonymizerDispatcher { contract_address: *self.address }
            .privacy_invoke(
                router_addr: *self.router,
                :token_amount,
                :pool_key,
                :minimum_received,
                :skip_ahead,
                :note_id,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke(
        self: @EkuboSwapAnonymizerCfg,
        router_addr: ContractAddress,
        token_amount: TokenAmount,
        pool_key: PoolKey,
        minimum_received: u256,
        skip_ahead: u128,
        note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.privacy_address,
        );
        IEkuboSwapAnonymizerSafeDispatcher { contract_address: *self.address }
            .privacy_invoke(
                :router_addr, :token_amount, :pool_key, :minimum_received, :skip_ahead, :note_id,
            )
    }

    /// Calls `privacy_invoke` from `caller` (no cheat to the trusted privacy address), used to
    /// exercise the caller-authorization guard.
    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke_from(
        self: @EkuboSwapAnonymizerCfg,
        caller: ContractAddress,
        token_amount: TokenAmount,
        pool_key: PoolKey,
        minimum_received: u256,
        skip_ahead: u128,
        note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        cheat_caller_address_once(contract_address: *self.address, caller_address: caller);
        IEkuboSwapAnonymizerSafeDispatcher { contract_address: *self.address }
            .privacy_invoke(
                router_addr: *self.router,
                :token_amount,
                :pool_key,
                :minimum_received,
                :skip_ahead,
                :note_id,
            )
    }
}

pub fn deploy_anonymizer_with_router() -> EkuboSwapAnonymizerCfg {
    let mock_router = deploy_mock_ekubo_amm();
    let privacy_address = privacy_contract();
    let anonymizer_address = deploy_ekubo_swap_anonymizer(privacy_contract: privacy_address);
    EkuboSwapAnonymizerCfg { address: anonymizer_address, router: mock_router, privacy_address }
}
