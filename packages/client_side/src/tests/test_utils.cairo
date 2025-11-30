use client_side::interface::{
    IClientSideDispatcher, IClientSideDispatcherTrait, IClientSideSafeDispatcher,
    IClientSideSafeDispatcherTrait, Note,
};
use core::num::traits::Zero;
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::ContractAddress;
use starkware_utils_testing::test_utils::cheat_caller_address_once;

#[derive(Copy, Drop)]
pub(crate) struct ClientSideCfg {
    pub client_side_contract: ContractAddress,
}

#[derive(Drop)]
struct User {
    pub address: ContractAddress,
    pub client_side: ContractAddress,
}

#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn transfer(self: @User, input: Span<Note>, output: Span<Note>) -> Span<felt252> {
        cheat_caller_address_once(
            contract_address: *self.client_side, caller_address: *self.address,
        );
        IClientSideDispatcher { contract_address: *self.client_side }.transfer(:input, :output)
    }

    #[feature("safe_dispatcher")]
    fn safe_transfer(
        self: @User, input: Span<Note>, output: Span<Note>,
    ) -> Result<Span<felt252>, Array<felt252>> {
        cheat_caller_address_once(
            contract_address: *self.client_side, caller_address: *self.address,
        );
        IClientSideSafeDispatcher { contract_address: *self.client_side }.transfer(:input, :output)
    }
}

#[derive(Drop, Copy)]
pub(crate) struct Test {
    pub cfg: ClientSideCfg,
    pub nonce: usize,
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_user(ref self: Test) -> User {
        self.nonce += 1;
        User {
            address: ('USER_ADDRESS' + self.nonce.into()).try_into().unwrap(),
            client_side: self.cfg.client_side_contract,
        }
    }

    fn new_token(ref self: Test) -> ContractAddress {
        self.nonce += 1;
        ('TOKEN_ADDRESS' + self.nonce.into()).try_into().unwrap()
    }
}

impl DefaultSystemImpl of Default<Test> {
    fn default() -> Test {
        let cfg = deploy_client_side();
        Test { cfg, nonce: Zero::zero() }
    }
}

pub(crate) fn deploy_client_side() -> ClientSideCfg {
    let mut calldata = array![];
    let contract_class = declare(contract: "ClientSide").unwrap().contract_class();
    let (contract_address, _) = contract_class.deploy(constructor_calldata: @calldata).unwrap();

    ClientSideCfg { client_side_contract: contract_address }
}

