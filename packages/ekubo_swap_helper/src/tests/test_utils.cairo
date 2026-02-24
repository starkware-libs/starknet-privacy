use core::num::traits::Zero;
use ekubo::interfaces::router::TokenAmount;
use ekubo::types::keys::PoolKey;
use ekubo_swap_helper::ekubo_swap_helper::{
    EkuboSwapHelper, IEkuboSwapHelperDispatcher, IEkuboSwapHelperDispatcherTrait,
    IEkuboSwapHelperSafeDispatcher, IEkuboSwapHelperSafeDispatcherTrait,
};
use ekubo_swap_helper::test_utils_contracts::mock_ekubo_amm::MockEkuboAMM::deploy_for_test as deploy_mock_ekubo_amm_for_test;
use privacy::objects::OpenNoteDeposit;
use snforge_std::{DeclareResultTrait, declare};
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};

pub fn deploy_mock_ekubo_amm() -> ContractAddress {
    let class_hash = declare(contract: "MockEkuboAMM").unwrap_syscall().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_ekubo_amm_for_test(
        class_hash: *class_hash, :deployment_params,
    )
        .expect('MockEkuboAMM deployment failed');
    contract_address
}

pub fn deploy_ekubo_swap_helper() -> ContractAddress {
    let class_hash = declare(contract: "EkuboSwapHelper")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = EkuboSwapHelper::deploy_for_test(
        class_hash: *class_hash, :deployment_params,
    )
        .expect('EkuboSwapHelper deploy failed');
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

/// Build calldata for EkuboSwapHelper::privacy_invoke.
pub fn build_ekubo_swap_helper_calldata(
    router_addr: ContractAddress,
    token_amount: TokenAmount,
    pool_key: PoolKey,
    minimum_received: u256,
    skip_ahead: u128,
    note_id: felt252,
) -> Array<felt252> {
    let mut calldata: Array<felt252> = array![];
    router_addr.serialize(ref calldata);
    token_amount.serialize(ref calldata);
    pool_key.serialize(ref calldata);
    minimum_received.serialize(ref calldata);
    skip_ahead.serialize(ref calldata);
    note_id.serialize(ref calldata);
    calldata
}

#[derive(Copy, Drop)]
pub struct EkuboSwapHelperCfg {
    pub address: ContractAddress,
    pub router: ContractAddress,
}

#[generate_trait]
pub impl EkuboSwapHelperCfgImpl of EkuboSwapHelperCfgTrait {
    fn privacy_invoke(
        self: @EkuboSwapHelperCfg,
        token_amount: TokenAmount,
        pool_key: PoolKey,
        minimum_received: u256,
        skip_ahead: u128,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit> {
        IEkuboSwapHelperDispatcher { contract_address: *self.address }
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
        self: @EkuboSwapHelperCfg,
        router_addr: ContractAddress,
        token_amount: TokenAmount,
        pool_key: PoolKey,
        minimum_received: u256,
        skip_ahead: u128,
        note_id: felt252,
    ) -> Result<Span<OpenNoteDeposit>, Array<felt252>> {
        IEkuboSwapHelperSafeDispatcher { contract_address: *self.address }
            .privacy_invoke(
                :router_addr, :token_amount, :pool_key, :minimum_received, :skip_ahead, :note_id,
            )
    }
}
