use server::interface::{
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
};
use server::objects::EncChannel;
use server::server::Server;
use server::server::Server::deploy_for_test;
use snforge_std::{DeclareResultTrait, declare, interact_with_state};
use starknet::ContractAddress;
use starknet::deployment::DeploymentParams;
use starknet::storage::{
    MutableVecTrait, StorableStoragePointerReadAccess, StorageMapReadAccess, StoragePathEntry,
    StoragePointerReadAccess,
};

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

#[generate_trait]
pub(crate) impl ServerCfgImpl of ServerCfgTrait {
    fn create_channel(
        self: @ServerCfg,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannel,
        channel_hash: felt252,
    ) {
        IServerDispatcher { contract_address: *self.address }
            .create_channel(:recipient_addr, :enc_channel_info, :channel_hash)
    }

    #[feature("safe_dispatcher")]
    fn safe_create_channel(
        self: @ServerCfg,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannel,
        channel_hash: felt252,
    ) -> Result<(), Array<felt252>> {
        IServerSafeDispatcher { contract_address: *self.address }
            .create_channel(:recipient_addr, :enc_channel_info, :channel_hash)
    }

    fn read_channel_hashes(self: @ServerCfg, key: felt252) -> bool {
        interact_with_state(
            *self.address,
            || {
                let mut state = Server::contract_state_for_testing();
                state.channel_hashes.read(:key)
            },
        )
    }

    fn read_channels_length(self: @ServerCfg, recipient_addr: ContractAddress) -> u64 {
        interact_with_state(
            *self.address,
            || {
                let mut state = Server::contract_state_for_testing();
                let channels_vec = state.channels.entry(key: recipient_addr);
                channels_vec.len()
            },
        )
    }

    fn read_channels_at(
        self: @ServerCfg, recipient_addr: ContractAddress, index: u64,
    ) -> EncChannel {
        interact_with_state(
            *self.address,
            || {
                let mut state = Server::contract_state_for_testing();
                let channels_vec = state.channels.entry(key: recipient_addr);
                channels_vec.at(:index).read()
            },
        )
    }
}
