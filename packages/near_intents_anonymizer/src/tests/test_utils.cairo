//! Common helpers used across the unit-test suites:
//! - `setup()` declares + deploys MockPool, MailboxReceiver class, and the
//!   anonymizer wired together.
//! - `deploy_test_erc20()` returns a `DualCaseERC20Mock` with a known owner
//!   holding the entire initial supply.
//! - Note + impersonation helpers wrap the snforge cheats so each test reads
//!   declaratively.

use near_intents_anonymizer::near_intents_anonymizer::INearIntentsAnonymizerDispatcher;
use near_intents_anonymizer::tests::mock_pool::{IMockPoolDispatcher, IMockPoolDispatcherTrait};
use openzeppelin::interfaces::token::erc20::IERC20Dispatcher;
use privacy::objects::Note;
use privacy::utils::constants::OPEN_NOTE_PACKED_VALUE;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::{ClassHash, ContractAddress};
use starkware_utils_testing::test_utils::{
    Deployable, TokenConfig, TokenState, TokenTrait,
};

// ---- Well-known test addresses ----
pub fn alice() -> ContractAddress {
    'ALICE'.try_into().unwrap()
}

pub fn bob() -> ContractAddress {
    'BOB'.try_into().unwrap()
}

pub fn keeper() -> ContractAddress {
    'KEEPER'.try_into().unwrap()
}

pub fn one_click_deposit_address() -> ContractAddress {
    'ONECLICK_DEPOSIT'.try_into().unwrap()
}

pub fn token_owner() -> ContractAddress {
    'TOKEN_OWNER'.try_into().unwrap()
}

pub const DEFAULT_AMOUNT: u128 = 1_000_000;
pub const INITIAL_SUPPLY: u256 = 1_000_000_000_000_000_000_000_u256;

#[derive(Drop, Copy)]
pub struct TestCtx {
    pub anonymizer: INearIntentsAnonymizerDispatcher,
    pub anonymizer_addr: ContractAddress,
    pub pool: IMockPoolDispatcher,
    pub pool_addr: ContractAddress,
    pub receiver_class_hash: ClassHash,
}

/// Deploy MockPool, declare MailboxReceiver, deploy the anonymizer wired to
/// the mock. Returns dispatchers for everything.
pub fn setup() -> TestCtx {
    let receiver_class = declare("MailboxReceiver").unwrap().contract_class().clone();
    let receiver_class_hash: ClassHash = receiver_class.class_hash;

    let pool_class = declare("MockPool").unwrap().contract_class().clone();
    let (pool_addr, _) = pool_class.deploy(@array![]).unwrap();

    let mut anon_ctor = array![];
    anon_ctor.append(pool_addr.into());
    anon_ctor.append(receiver_class_hash.into());
    let anon_class = declare("NearIntentsAnonymizer").unwrap().contract_class().clone();
    let (anonymizer_addr, _) = anon_class.deploy(@anon_ctor).unwrap();

    TestCtx {
        anonymizer: INearIntentsAnonymizerDispatcher { contract_address: anonymizer_addr },
        anonymizer_addr,
        pool: IMockPoolDispatcher { contract_address: pool_addr },
        pool_addr,
        receiver_class_hash,
    }
}

/// Deploy a fresh ERC-20 mock; entire supply held by `token_owner()`.
pub fn deploy_test_erc20() -> TokenState {
    let config = TokenConfig {
        name: "TestToken",
        symbol: "TT",
        decimals: 18,
        initial_supply: INITIAL_SUPPLY,
        owner: token_owner(),
    };
    config.deploy()
}

/// Convenience: erc20 dispatcher view over a `TokenState`.
pub fn erc20(token: TokenState) -> IERC20Dispatcher {
    IERC20Dispatcher { contract_address: token.address }
}

/// Move `amount` of `token` from `token_owner()` to `recipient`.
pub fn fund(token: TokenState, recipient: ContractAddress, amount: u128) {
    token.fund(recipient, amount);
}

/// Build an empty open-note record. Tests can pass this to `pool.set_note(...)`
/// to make the anonymizer's depositor-verify roundtrip succeed.
pub fn make_open_note(token: ContractAddress, depositor: ContractAddress) -> Note {
    Note { packed_value: OPEN_NOTE_PACKED_VALUE, token, depositor }
}

/// Program the mock pool to return `note` for `note_id` on `get_note`.
pub fn set_pool_note(ctx: TestCtx, note_id: felt252, note: Note) {
    ctx.pool.set_note(note_id, note);
}

/// Start impersonating the privacy pool as caller into the anonymizer.
/// Used to drive `privacy_invoke` past its strict caller-auth check.
pub fn start_pool_impersonation(ctx: TestCtx) {
    start_cheat_caller_address(ctx.anonymizer_addr, ctx.pool_addr);
}

pub fn stop_pool_impersonation(ctx: TestCtx) {
    stop_cheat_caller_address(ctx.anonymizer_addr);
}

/// Convenience: assert the mock pool recorded a deposit of `expected` into `note_id`.
pub fn assert_deposited(ctx: TestCtx, note_id: felt252, expected: u128) {
    let actual = ctx.pool.deposited_amount(note_id);
    assert(actual == expected, 'deposited mismatch');
}
