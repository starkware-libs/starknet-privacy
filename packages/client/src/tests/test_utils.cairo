use client::client::Client::deploy_for_test;
use client::interface::{
    IClientDispatcher, IClientDispatcherTrait, IClientSafeDispatcher, IClientSafeDispatcherTrait,
};
use client::objects::{NewNote, NotePath};
use core::num::traits::Zero;
use server::objects::EncNote;
use snforge_std::{DeclareResultTrait, declare};
use starknet::ContractAddress;
use starknet::deployment::DeploymentParams;
use starknet::storage::StorableStoragePointerReadAccess;

#[derive(Copy, Drop)]
pub(crate) struct ClientCfg {
    pub address: ContractAddress,
    pub server: ContractAddress,
}

#[derive(Copy, Drop)]
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
    ) -> (Span<felt252>, Span<EncNote>) {
        IClientDispatcher { contract_address: *self.client }
            .transfer(
                owner: *self.address,
                owner_private_key: *self.private_key,
                :notes_to_use,
                :notes_to_create,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> Result<(Span<felt252>, Span<EncNote>), Array<felt252>> {
        IClientSafeDispatcher { contract_address: *self.client }
            .transfer(
                owner: *self.address,
                owner_private_key: *self.private_key,
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

    let contract_class_hash = declare(contract: "Client").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_for_test(
        class_hash: *contract_class_hash, :deployment_params, :server,
    )
        .expect('Deployment failed');
    ClientCfg { address: contract_address, server }
}
