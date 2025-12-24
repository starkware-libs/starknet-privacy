use core::array::Span;
use core::num::traits::Zero;
use privacy::objects::EncNote;
use snforge_std::{CustomToken, DeclareResultTrait, Token, declare, interact_with_state};
use starknet::ContractAddress;
use starknet::deployment::DeploymentParams;
use starkware_utils_testing::test_utils::{Deployable, TokenConfig};
use swap_executor::interface::{ISwapExecutorSafeDispatcher, ISwapExecutorSafeDispatcherTrait};
use swap_executor::swap_executor::SwapExecutor::deploy_for_test as deploy_swap_executor_for_test;
use swap_executor::tests::mock_amm::MockAMM::deploy_for_test as deploy_mock_amm_for_test;
use swap_executor::tests::mock_privacy::MockPrivacy::{
    MockPrivacyInternalTrait, deploy_for_test as deploy_mock_privacy_for_test,
};

pub(crate) mod constants {
    use core::num::traits::Pow;
    use starknet::ContractAddress;

    pub const DECIMALS: u8 = 18;
    pub const TOKEN_SUPPLY: u256 = 10_u256.pow(12 + DECIMALS.into());
    pub const TOKEN_OWNER: ContractAddress = 'TOKEN_OWNER'.try_into().unwrap();
    pub const DEFAULT_AMOUNT: u128 = 10_u128.pow(DECIMALS.into());
    pub const DEFAULT_EXCHANGE_RATE: u256 = 1000_u256; // 1:1 swap
}

#[derive(Copy, Drop)]
pub(crate) struct SwapExecutorCfg {
    pub address: ContractAddress,
    pub privacy: ContractAddress,
}

#[derive(Copy, Drop)]
pub(crate) struct MockAMMCfg {
    pub address: ContractAddress,
}

#[derive(Copy, Drop)]
pub(crate) struct Test {
    pub cfg: SwapExecutorCfg,
    pub nonce: usize,
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_token(ref self: Test) -> Token {
        self.nonce += 1;
        let config = TokenConfig {
            name: format!("Token {}", self.nonce),
            symbol: format!("Token {}", self.nonce),
            decimals: constants::DECIMALS,
            initial_supply: constants::TOKEN_SUPPLY,
            owner: constants::TOKEN_OWNER,
        };
        let token = config.deploy();
        Token::Custom(
            CustomToken {
                contract_address: token.address,
                balances_variable_selector: selector!("ERC20_balances"),
            },
        )
    }

    fn new_note(ref self: Test, amount: u128) -> EncNote {
        self.nonce += 1;
        let id = ('NOTE_ID' + self.nonce.into()).try_into().unwrap();
        // TODO: Encrypt amount properly.
        let enc_amount = ('ENC' + amount.into() + self.nonce.into()).try_into().unwrap();
        EncNote { id, enc_amount }
    }
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let cfg = deploy_swap_executor();
        Test { cfg, nonce: Zero::zero() }
    }
}

pub(crate) fn deploy_swap_executor() -> SwapExecutorCfg {
    let privacy = deploy_mock_privacy();

    let contract_class_hash = declare(contract: "SwapExecutor")
        .unwrap()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_swap_executor_for_test(
        class_hash: *contract_class_hash, :deployment_params, privacy_pool: privacy,
    )
        .expect('SwapExecutor deployment failed');
    SwapExecutorCfg { address: contract_address, privacy }
}

pub(crate) fn deploy_mock_privacy() -> ContractAddress {
    let contract_class_hash = declare(contract: "MockPrivacy").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_privacy_for_test(
        class_hash: *contract_class_hash, :deployment_params,
    )
        .expect('MockPrivacy deployment failed');
    contract_address
}

pub(crate) fn deploy_mock_amm(exchange_rate: u256) -> MockAMMCfg {
    let contract_class_hash = declare(contract: "MockAMM").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_amm_for_test(
        class_hash: *contract_class_hash, :deployment_params, exchange_rate: exchange_rate,
    )
        .expect('MockAMM deployment failed');
    MockAMMCfg { address: contract_address }
}

#[generate_trait]
pub(crate) impl SwapExecutorCfgImpl of SwapExecutorCfgTrait {
    fn create_note(self: @SwapExecutorCfg, note: EncNote) {
        interact_with_state(
            *self.privacy,
            || {
                let mut state =
                    swap_executor::tests::mock_privacy::MockPrivacy::contract_state_for_testing();
                state._create_note(:note)
            },
        )
    }

    #[feature("safe_dispatcher")]
    fn safe_swap_and_deposit(
        self: @SwapExecutorCfg,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        owner_addr: ContractAddress,
        token: ContractAddress,
        amount: u128,
        note_id: felt252,
    ) -> Result<(), Array<felt252>> {
        ISwapExecutorSafeDispatcher { contract_address: *self.address }
            .swap_and_deposit(
                swap_contract: swap_contract,
                swap_selector: swap_selector,
                swap_calldata: swap_calldata,
                owner_addr: owner_addr,
                token: token,
                amount: amount,
                note_id: note_id,
            )
    }
}

