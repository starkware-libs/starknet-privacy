use core::num::traits::Zero;
use server::interface::{
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
};
use server::objects::EncChannelInfo;
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::ContractAddress;

// TODO: Consider merging test utils for client and server in shared package.

#[derive(Copy, Drop)]
pub(crate) struct ServerCfg {
    pub address: ContractAddress,
}

pub(crate) fn deploy_server() -> ServerCfg {
    let calldata = array![];
    let contract_class = declare(contract: "Server").unwrap().contract_class();
    let (contract_address, _) = contract_class.deploy(constructor_calldata: @calldata).unwrap();

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

    /// Returns the encrypted channel information and the channel hash.
    fn new_channel(ref self: Test) -> (EncChannelInfo, felt252) {
        self.nonce += 1;
        let enc_channel_info = EncChannelInfo {
            ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + self.nonce.into()).try_into().unwrap(),
            enc_channel_key: ('ENC_CHANNEL_KEY' + self.nonce.into()).try_into().unwrap(),
            enc_token: ('ENC_TOKEN' + self.nonce.into()).try_into().unwrap(),
            enc_sender_addr: ('ENC_SENDER_ADDR' + self.nonce.into()).try_into().unwrap(),
        };
        let channel_hash = ('CHANNEL_HASH' + self.nonce.into()).try_into().unwrap();
        (enc_channel_info, channel_hash)
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
}
