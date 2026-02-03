use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::{PoseidonTrait, poseidon_hash_span};
use privacy::interface::{IClientDispatcher, IServerDispatcher, IViewsDispatcher};
use privacy::objects::Note;
use privacy::privacy::Privacy::deploy_for_test as deploy_privacy_for_test;
use privacy::utils::constants::OPEN_NOTE_SALT;
use snforge_std::{CustomToken, DeclareResultTrait, Token, declare, map_entry_address, store};
use starknet::deployment::DeploymentParams;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils_testing::test_utils::{
    Deployable, TokenConfig, set_account_as_app_role_admin, set_account_as_security_agent,
    set_account_as_token_admin,
};
use swap_executor::interface::{
    ISwapExecutorDispatcher, ISwapExecutorDispatcherTrait, ISwapExecutorSafeDispatcher,
    ISwapExecutorSafeDispatcherTrait,
};
use swap_executor::swap_executor::SwapExecutor::deploy_for_test as deploy_swap_executor_for_test;
use crate::tests::mock_amm::MockAMM::deploy_for_test as deploy_mock_amm_for_test;

pub(crate) mod constants {
    use core::num::traits::Pow;
    use starknet::ContractAddress;
    use crate::tests::mock_amm::RATE_DENOMINATOR;

    pub const DECIMALS: u8 = 18;
    pub const TOKEN_SUPPLY: u256 = 10_u256.pow(12 + DECIMALS.into());
    pub const TOKEN_OWNER: ContractAddress = 'TOKEN_OWNER'.try_into().unwrap();
    pub const DEFAULT_AMOUNT: u128 = 10_u128.pow(DECIMALS.into());
    pub const DEFAULT_EXCHANGE_RATE: u256 = RATE_DENOMINATOR; // 1:1 swap
    pub const TWO_POW_128: u256 = 2_u256.pow(128);
    pub const GOVERNANCE_ADMIN: ContractAddress = 'GOVERNANCE_ADMIN'.try_into().unwrap();
    pub const SECURITY_AGENT: ContractAddress = 'SECURITY_AGENT'.try_into().unwrap();
    pub const APP_ROLE_ADMIN: ContractAddress = 'APP_ROLE_ADMIN'.try_into().unwrap();
    pub const TOKEN_ADMIN: ContractAddress = 'TOKEN_ADMIN'.try_into().unwrap();
    pub const COMPLIANCE_PRIVATE_KEY: felt252 = 'COMPLIANCE_PRIVATE_KEY';
}

#[derive(Copy, Drop)]
pub(crate) struct PrivacyCfg {
    pub address: ContractAddress,
    pub nonce: usize,
}

#[derive(Copy, Drop)]
pub(crate) struct SwapExecutorCfg {
    pub address: ContractAddress,
    pub privacy_address: ContractAddress,
}

#[derive(Copy, Drop)]
pub(crate) struct MockAMMCfg {
    pub address: ContractAddress,
}

#[derive(Copy, Drop)]
pub(crate) struct Test {
    pub privacy: PrivacyCfg,
    pub swap_executor: SwapExecutorCfg,
    pub mock_amm: MockAMMCfg,
    pub token_nonce: usize,
}

/// Local hash function (poseidon).
fn hash(data: Span<felt252>) -> felt252 {
    PoseidonTrait::new().update_with(poseidon_hash_span(data)).finalize()
}

/// Derive public key from private key (simplified for tests).
fn derive_public_key(private_key: felt252) -> felt252 {
    hash(['PUBLIC_KEY', private_key].span())
}

#[generate_trait]
pub(crate) impl PrivacyCfgImpl of PrivacyCfgTrait {
    fn get_views_dispatcher(self: @PrivacyCfg) -> IViewsDispatcher {
        IViewsDispatcher { contract_address: *self.address }
    }

    fn get_server_dispatcher(self: @PrivacyCfg) -> IServerDispatcher {
        IServerDispatcher { contract_address: *self.address }
    }

    fn get_client_dispatcher(self: @PrivacyCfg) -> IClientDispatcher {
        IClientDispatcher { contract_address: *self.address }
    }

    /// Create an open note directly in storage (bypassing channel/subchannel setup).
    /// Returns the note_id.
    fn cheat_create_open_note(
        ref self: PrivacyCfg, token: ContractAddress, depositor: ContractAddress,
    ) -> felt252 {
        self.nonce += 1;
        let note_id: felt252 = 'NOTE_ID' + self.nonce.into();

        // Compute packed_value for empty open note: packing(OPEN_NOTE_SALT, 0).
        let packed_value = compute_open_note_packed_value(amount: 0);

        // Create the Note struct.
        let note = Note { packed_value, token, depositor };

        // Get storage address for notes map.
        let storage_address = map_entry_address(
            map_selector: selector!("notes"), keys: [note_id].span(),
        );

        // Store the note in privacy contract.
        // Note struct layout: packed_value (felt252), token (ContractAddress), depositor
        // (ContractAddress)
        store(
            target: self.address,
            :storage_address,
            serialized_value: [note.packed_value, note.token.into(), note.depositor.into()].span(),
        );

        note_id
    }
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_token(ref self: Test) -> Token {
        self.token_nonce += 1;
        let config = TokenConfig {
            name: format!("Token {}", self.token_nonce),
            symbol: format!("Token {}", self.token_nonce),
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
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        // Deploy privacy contract.
        let compliance_public_key = derive_public_key(
            private_key: constants::COMPLIANCE_PRIVATE_KEY,
        );
        let privacy_address = deploy_privacy(
            governance_admin: constants::GOVERNANCE_ADMIN, :compliance_public_key,
        );
        let privacy = PrivacyCfg { address: privacy_address, nonce: 0 };

        // Deploy swap executor.
        let swap_executor = deploy_swap_executor(:privacy_address);

        // Deploy mock AMM with default 1:1 exchange rate.
        let mock_amm = deploy_mock_amm(exchange_rate: constants::DEFAULT_EXCHANGE_RATE);

        Test { privacy, swap_executor, mock_amm, token_nonce: 0 }
    }
}

fn deploy_privacy(
    governance_admin: ContractAddress, compliance_public_key: felt252,
) -> ContractAddress {
    let contract_class_hash = declare(contract: "Privacy")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_privacy_for_test(
        class_hash: *contract_class_hash,
        :deployment_params,
        :governance_admin,
        :compliance_public_key,
    )
        .expect('Privacy deployment failed');

    // Set up roles.
    set_account_as_security_agent(
        contract: contract_address,
        account: constants::SECURITY_AGENT,
        security_admin: constants::GOVERNANCE_ADMIN,
    );
    set_account_as_app_role_admin(
        contract: contract_address,
        account: constants::APP_ROLE_ADMIN,
        governance_admin: constants::GOVERNANCE_ADMIN,
    );
    set_account_as_token_admin(
        contract: contract_address,
        account: constants::TOKEN_ADMIN,
        app_role_admin: constants::APP_ROLE_ADMIN,
    );

    contract_address
}

pub(crate) fn deploy_swap_executor(privacy_address: ContractAddress) -> SwapExecutorCfg {
    let contract_class_hash = declare(contract: "SwapExecutor")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_swap_executor_for_test(
        class_hash: *contract_class_hash, :deployment_params, privacy_pool: privacy_address,
    )
        .expect('SwapExecutor deploy failed');

    SwapExecutorCfg { address: contract_address, privacy_address }
}

pub(crate) fn deploy_mock_amm(exchange_rate: u256) -> MockAMMCfg {
    let contract_class_hash = declare(contract: "MockAMM")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_amm_for_test(
        class_hash: *contract_class_hash, :deployment_params, :exchange_rate,
    )
        .expect('MockAMM deployment failed');
    MockAMMCfg { address: contract_address }
}

#[generate_trait]
pub(crate) impl SwapExecutorCfgImpl of SwapExecutorCfgTrait {
    fn swap_and_deposit(
        self: @SwapExecutorCfg,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        input_token: ContractAddress,
        output_token: ContractAddress,
        amount: u128,
        note_id: felt252,
    ) {
        let dispatcher = ISwapExecutorDispatcher { contract_address: *self.address };
        ISwapExecutorDispatcherTrait::swap_and_deposit(
            dispatcher,
            :swap_contract,
            :swap_selector,
            :swap_calldata,
            :input_token,
            :output_token,
            :amount,
            :note_id,
        );
    }

    #[feature("safe_dispatcher")]
    fn safe_swap_and_deposit(
        self: @SwapExecutorCfg,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        input_token: ContractAddress,
        output_token: ContractAddress,
        amount: u128,
        note_id: felt252,
    ) -> Result<(), Array<felt252>> {
        ISwapExecutorSafeDispatcher { contract_address: *self.address }
            .swap_and_deposit(
                :swap_contract,
                :swap_selector,
                :swap_calldata,
                :input_token,
                :output_token,
                :amount,
                :note_id,
            )
    }

    fn get_privacy_pool(self: @SwapExecutorCfg) -> ContractAddress {
        ISwapExecutorDispatcher { contract_address: *self.address }.get_privacy_pool()
    }
}

/// Compute packed value for open notes: packing(OPEN_NOTE_SALT, amount).
pub(crate) fn compute_open_note_packed_value(amount: u128) -> felt252 {
    let salt: u256 = OPEN_NOTE_SALT.into();
    let amount_u256: u256 = amount.into();
    let packed: u256 = salt * constants::TWO_POW_128 + amount_u256;
    packed.try_into().unwrap()
}
