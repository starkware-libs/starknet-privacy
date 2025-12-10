use client::interface::{
    IClientDispatcher, IClientDispatcherTrait, IClientSafeDispatcher, IClientSafeDispatcherTrait,
};
use client::objects::{EncryptedNote, NewNote, NotePath};
use core::num::traits::Zero;
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::ContractAddress;

#[derive(Copy, Drop)]
pub(crate) struct ClientCfg {
    pub address: ContractAddress,
    pub server: ContractAddress,
}

#[derive(Drop)]
struct User {
    pub address: ContractAddress,
    pub client: ContractAddress,
    pub private_key: felt252,
    pub public_key: felt252,
}

#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> (Span<felt252>, Span<EncryptedNote>) {
        IClientDispatcher { contract_address: *self.client }
            .transfer(
                owner: *self.address,
                private_key: *self.private_key,
                :notes_to_use,
                :notes_to_create,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> Result<(Span<felt252>, Span<EncryptedNote>), Array<felt252>> {
        IClientSafeDispatcher { contract_address: *self.client }
            .transfer(
                owner: *self.address,
                private_key: *self.private_key,
                :notes_to_use,
                :notes_to_create,
            )
    }
}

#[derive(Drop, Copy)]
pub(crate) struct Test {
    pub cfg: ClientCfg,
    pub nonce: usize,
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_user(ref self: Test) -> User {
        self.nonce += 1;
        User {
            address: ('USER_ADDRESS' + self.nonce.into()).try_into().unwrap(),
            client: self.cfg.address,
            // TODO: Generate valid private-public key pair.
            private_key: ('PRIVATE_KEY' + self.nonce.into()).try_into().unwrap(),
            public_key: ('PUBLIC_KEY' + self.nonce.into()).try_into().unwrap(),
        }
    }

    fn new_token(ref self: Test) -> ContractAddress {
        self.nonce += 1;
        ('TOKEN_ADDRESS' + self.nonce.into()).try_into().unwrap()
    }
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let cfg = deploy_client();
        Test { cfg, nonce: Zero::zero() }
    }
}

pub(crate) fn deploy_client() -> ClientCfg {
    let server: ContractAddress = 'SERVER_ADDRESS'.try_into().unwrap();

    let mut calldata = array![];
    calldata.append(server.into());
    let contract_class = declare(contract: "Client").unwrap().contract_class();
    let (contract_address, _) = contract_class.deploy(constructor_calldata: @calldata).unwrap();

    ClientCfg { address: contract_address, server }
}
