use client_side::interface::{
    IClientSideSafeDispatcher, IClientSideSafeDispatcherTrait, Note, NoteTrait,
};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::ContractAddress;
use starkware_utils_testing::test_utils::cheat_caller_address_once;

#[derive(Copy, Drop)]
struct ClientSideCfg {
    pub client_side_contract: ContractAddress,
    pub token: ContractAddress,
    pub user: ContractAddress,
}

pub(crate) fn deploy_client_side() -> ClientSideCfg {
    let mut calldata = array![];
    let contract_class = declare(contract: "ClientSide").unwrap().contract_class();
    let (contract_address, _) = contract_class.deploy(constructor_calldata: @calldata).unwrap();

    ClientSideCfg {
        client_side_contract: contract_address,
        token: 'TOKEN_ADDRESS'.try_into().unwrap(),
        user: 'USER_ADDRESS'.try_into().unwrap(),
    }
}

#[feature("safe_dispatcher")]
pub(crate) fn safe_transfer_as_user(
    cfg: ClientSideCfg, input: Span<Note>, output: Span<Note>,
) -> Result<Span<felt252>, Array<felt252>> {
    cheat_caller_address_once(contract_address: cfg.client_side_contract, caller_address: cfg.user);
    IClientSideSafeDispatcher { contract_address: cfg.client_side_contract }
        .transfer(:input, :output)
}

pub(crate) fn valid_note(cfg: ClientSideCfg, amount: u256) -> Note {
    NoteTrait::new(owner: cfg.user, token: cfg.token, :amount)
}
