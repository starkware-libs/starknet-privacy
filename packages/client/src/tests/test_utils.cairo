use client::client::Client::deploy_for_test as deploy_client_for_test;
use client::interface::{
    IClientDispatcher, IClientDispatcherTrait, IClientSafeDispatcher, IClientSafeDispatcherTrait,
};
use client::objects::{NewNote, NotePath};
use client::utils::{derive_public_key, hash};
use core::num::traits::Zero;
use server::interface::{IServerDispatcher, IServerDispatcherTrait};
use server::objects::{EncChannelInfo, EncNote};
use server::server::Server::deploy_for_test as deploy_server_for_test;
use snforge_std::{DeclareResultTrait, declare};
use starknet::ContractAddress;
use starknet::deployment::DeploymentParams;
use starknet::storage::StorableStoragePointerReadAccess;
use starkware_utils_testing::test_utils::cheat_caller_address_once;

#[derive(Copy, Drop)]
pub(crate) struct ClientCfg {
    pub address: ContractAddress,
    pub server: ContractAddress,
}

#[derive(Drop, Copy)]
struct User {
    pub address: ContractAddress,
    pub client: ContractAddress,
    pub server: ContractAddress,
    pub private_key: felt252,
    pub public_key: felt252,
    nonce: usize,
}

#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> (Span<felt252>, Span<EncNote>) {
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
    ) -> Result<(Span<felt252>, Span<EncNote>), Array<felt252>> {
        IClientSafeDispatcher { contract_address: *self.client }
            .transfer(
                owner: *self.address,
                private_key: *self.private_key,
                :notes_to_use,
                :notes_to_create,
            )
    }

    fn open_channel(
        self: @User, recipient: User, token: ContractAddress, random: felt252,
    ) -> (ContractAddress, EncChannelInfo, felt252) {
        IClientDispatcher { contract_address: *self.client }
            .open_channel(
                sender_addr: *self.address,
                sender_private_key: *self.private_key,
                recipient_addr: recipient.address,
                :token,
                :random,
            )
    }

    /// Returns (random, output) where output is the output of `open_channel`.
    fn open_channel_generate_random(
        ref self: User, recipient: User, token: ContractAddress,
    ) -> (felt252, (ContractAddress, EncChannelInfo, felt252)) {
        let random = self.get_random();
        let output = self.open_channel(recipient: recipient, :token, random: random);
        (random, output)
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel(
        self: @User, recipient: User, token: ContractAddress, random: felt252,
    ) -> Result<(ContractAddress, EncChannelInfo, felt252), Array<felt252>> {
        IClientSafeDispatcher { contract_address: *self.client }
            .open_channel(
                sender_addr: *self.address,
                sender_private_key: *self.private_key,
                recipient_addr: recipient.address,
                :token,
                :random,
            )
    }

    fn register_server(self: @User) {
        cheat_caller_address_once(contract_address: *self.server, caller_address: *self.address);
        IServerDispatcher { contract_address: *self.server }.register(public_key: *self.public_key)
    }

    fn get_random(ref self: User) -> felt252 {
        self.nonce += 1;
        hash(['RANDOM', self.nonce.into()].span())
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
        let private_key = ('PRIVATE_KEY' + self.nonce.into()).try_into().unwrap();
        let public_key = derive_public_key(:private_key);
        User {
            address: ('USER_ADDRESS' + self.nonce.into()).try_into().unwrap(),
            client: self.cfg.address,
            server: self.cfg.server,
            private_key,
            public_key,
            nonce: Zero::zero(),
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
    let server = deploy_server();

    let contract_class_hash = declare(contract: "Client").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_client_for_test(
        class_hash: *contract_class_hash, :deployment_params, :server,
    )
        .expect('Client deployment failed');
    ClientCfg { address: contract_address, server }
}

// TODO: Import from server or shared package.
pub(crate) fn deploy_server() -> ContractAddress {
    let contract_class_hash = declare(contract: "Server").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_server_for_test(
        class_hash: *contract_class_hash, :deployment_params,
    )
        .expect('Server deployment failed');
    contract_address
}
