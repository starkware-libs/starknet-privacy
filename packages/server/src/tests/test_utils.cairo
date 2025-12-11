use core::num::traits::Zero;
use server::interface::{
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
};
use server::objects::{EncChannelInfo, EncNote};
use server::server::Server;
use server::server::Server::{ServerInternalTrait, deploy_for_test};
use snforge_std::{DeclareResultTrait, declare, interact_with_state};
use starknet::deployment::DeploymentParams;
use starknet::storage::StorableStoragePointerReadAccess;
use starknet::{ContractAddress, contract_address};
use starkware_utils_testing::test_utils::cheat_caller_address_once;

// TODO: Consider merging test utils for client and server in shared package.

#[derive(Copy, Drop)]
pub(crate) struct ServerCfg {
    pub address: ContractAddress,
}

pub(crate) fn deploy_server() -> ServerCfg {
    let contract_class_hash = declare(contract: "Server").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_for_test(
        class_hash: *contract_class_hash, :deployment_params,
    )
        .expect('Deployment failed');
    ServerCfg { address: contract_address }
}

#[derive(Drop, Copy)]
pub(crate) struct Test {
    pub server: ServerCfg,
    pub nonce: usize,
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let server = deploy_server();
        Test { server, nonce: Zero::zero() }
    }
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_user(ref self: Test) -> User {
        self.nonce += 1;
        User {
            address: ('USER_ADDRESS' + self.nonce.into()).try_into().unwrap(),
            server: self.server.address,
            // TODO: Generate valid private-public key pair.
            private_key: ('PRIVATE_KEY' + self.nonce.into()).try_into().unwrap(),
            public_key: ('PUBLIC_KEY' + self.nonce.into()).try_into().unwrap(),
        }
    }

    /// Returns the encrypted channel information and the channel id.
    fn new_channel(ref self: Test) -> (EncChannelInfo, felt252) {
        self.nonce += 1;
        let enc_channel_info = EncChannelInfo {
            ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + self.nonce.into()).try_into().unwrap(),
            enc_channel_key: ('ENC_CHANNEL_KEY' + self.nonce.into()).try_into().unwrap(),
            enc_token: ('ENC_TOKEN' + self.nonce.into()).try_into().unwrap(),
            enc_sender_addr: ('ENC_SENDER_ADDR' + self.nonce.into()).try_into().unwrap(),
        };
        let channel_id = ('CHANNEL_ID' + self.nonce.into()).try_into().unwrap();
        (enc_channel_info, channel_id)
    }

    /// Returns the note id and the encrypted note value.
    fn new_note(ref self: Test) -> EncNote {
        self.nonce += 1;
        let id = ('NOTE_ID' + self.nonce.into()).try_into().unwrap();
        let enc_amount = ('ENC_AMOUNT' + self.nonce.into()).try_into().unwrap();
        EncNote { id, enc_amount }
    }

    fn new_nullifier(ref self: Test) -> felt252 {
        self.nonce += 1;
        ('NULLIFIER' + self.nonce.into()).try_into().unwrap()
    }
}

#[derive(Drop)]
struct User {
    pub address: ContractAddress,
    pub server: ContractAddress,
    pub private_key: felt252,
    pub public_key: felt252,
}

#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn get_num_of_channels(self: @User) -> u64 {
        IServerDispatcher { contract_address: *self.server }
            .get_num_of_channels(recipient_addr: *self.address)
    }

    fn get_channel_info(self: @User, channel_index: u64) -> EncChannelInfo {
        IServerDispatcher { contract_address: *self.server }
            .get_channel_info(recipient_addr: *self.address, :channel_index)
    }

    #[feature("safe_dispatcher")]
    fn safe_get_channel_info(
        self: @User, channel_index: u64,
    ) -> Result<EncChannelInfo, Array<felt252>> {
        IServerSafeDispatcher { contract_address: *self.server }
            .get_channel_info(recipient_addr: *self.address, :channel_index)
    }

    fn register(self: @User) {
        cheat_caller_address_once(contract_address: *self.server, caller_address: *self.address);
        IServerDispatcher { contract_address: *self.server }.register(public_key: *self.public_key)
    }

    #[feature("safe_dispatcher")]
    fn safe_register(self: @User) -> Result<(), Array<felt252>> {
        cheat_caller_address_once(contract_address: *self.server, caller_address: *self.address);
        IServerSafeDispatcher { contract_address: *self.server }
            .register(public_key: *self.public_key)
    }

    fn get_public_key(self: @User) -> felt252 {
        IServerDispatcher { contract_address: *self.server }.get_public_key(user: *self.address)
    }
}

#[generate_trait]
pub(crate) impl ServerCfgImpl of ServerCfgTrait {
    fn open_channel(
        self: @ServerCfg,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannelInfo,
        channel_id: felt252,
    ) {
        IServerDispatcher { contract_address: *self.address }
            .open_channel(:recipient_addr, :enc_channel_info, :channel_id)
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel(
        self: @ServerCfg,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannelInfo,
        channel_id: felt252,
    ) -> Result<(), Array<felt252>> {
        IServerSafeDispatcher { contract_address: *self.address }
            .open_channel(:recipient_addr, :enc_channel_info, :channel_id)
    }

    fn channel_exists(self: @ServerCfg, channel_id: felt252) -> bool {
        IServerDispatcher { contract_address: *self.address }.channel_exists(:channel_id)
    }

    fn create_note(self: @ServerCfg, note: EncNote) {
        interact_with_state(
            *self.address,
            || {
                let mut state = Server::contract_state_for_testing();
                state.create_note(:note)
            },
        )
    }

    fn get_note(self: @ServerCfg, note_id: felt252) -> felt252 {
        IServerDispatcher { contract_address: *self.address }.get_note(:note_id)
    }

    fn use_note(self: @ServerCfg, nullifier: felt252) {
        interact_with_state(
            *self.address,
            || {
                let mut state = Server::contract_state_for_testing();
                state.use_note(:nullifier)
            },
        )
    }

    fn nullifier_exists(self: @ServerCfg, nullifier: felt252) -> bool {
        IServerDispatcher { contract_address: *self.address }.nullifier_exists(:nullifier)
    }
}

