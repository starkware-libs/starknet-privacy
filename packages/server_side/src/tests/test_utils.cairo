use core::num::traits::Zero;
use server_side::interface::{IServerSideDispatcher, IServerSideDispatcherTrait};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare, map_entry_address, store};
use starknet::ContractAddress;

#[derive(Copy, Drop)]
pub(crate) struct ServerSideCfg {
    pub address: ContractAddress,
}

#[derive(Drop, Copy)]
pub(crate) struct Note {
    pub hash: felt252,
    pub server_side: ContractAddress,
}

#[generate_trait]
pub(crate) impl NoteImpl of NoteTrait {
    fn is_active(self: @Note) -> bool {
        IServerSideDispatcher { contract_address: *self.server_side }.is_active(*self.hash)
    }
}

#[derive(Drop, Copy)]
pub(crate) struct Test {
    pub cfg: ServerSideCfg,
    pub nonce: usize,
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_note(ref self: Test) -> Note {
        self.nonce += 1;
        let hash = ('NOTE_HASH' + self.nonce.into()).try_into().unwrap();
        Note { hash, server_side: self.cfg.address }
    }
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let cfg = deploy_server_side();
        Test { cfg, nonce: Zero::zero() }
    }
}

pub(crate) fn deploy_server_side() -> ServerSideCfg {
    let mut calldata = array![];
    let contract_class = declare("ServerSide").unwrap().contract_class();
    let (contract_address, _) = contract_class.deploy(@calldata).unwrap();

    ServerSideCfg { address: contract_address }
}

pub(crate) fn map_store<K, V, +Into<K, felt252>, +Serde<V>, +Drop<V>>(
    contract_address: ContractAddress, selector: felt252, key: K, value: V,
) {
    let storage_address = map_entry_address(selector, array![key.into()].span());
    let mut serialized_value = array![];
    value.serialize(ref serialized_value);

    store(contract_address, storage_address, serialized_value.span());
}
