#[starknet::contract]
pub mod Server {
    use core::num::traits::Zero;
    use server::errors;
    use server::interface::IServer;
    use server::objects::{EncChannelInfo, EncChannelInfoTrait};
    use starknet::ContractAddress;
    use starknet::storage::{
        Map, MutableVecTrait, StorageMapReadAccess, StorageMapWriteAccess, StoragePathEntry, Vec,
    };

    #[storage]
    struct Storage {
        /// Map of recipient addresses to a list of their encrypted channels.
        pub channels: Map<ContractAddress, Vec<EncChannelInfo>>,
        /// Map of channel hash to whether it exists.
        pub channel_hashes: Map<felt252, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState) { //constructor logic
    }

    #[abi(embed_v0)]
    pub impl ServerImpl of IServer<ContractState> {
        fn open_channel(
            ref self: ContractState,
            recipient_addr: ContractAddress,
            enc_channel_info: EncChannelInfo,
            channel_hash: felt252,
        ) {
            // Assert inputs are not zero.
            // TODO: Remove assert not zero for hashes?
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(enc_channel_info.is_non_zero(), errors::ZERO_ENC_CHANNEL_INFO);
            assert(channel_hash.is_non_zero(), errors::ZERO_CHANNEL_HASH);

            // TODO: Verify client's proof.

            // TODO: Consider add `recipient_public_key` to the params and assert it is the current
            // public key of `recipient_addr`.

            // Assert channel does not already exist.
            assert(!self.channel_hashes.read(channel_hash), errors::CHANNEL_ALREADY_EXISTS);

            // Write channel to storage.
            self.channel_hashes.write(channel_hash, true);
            self.channels.entry(recipient_addr).push(enc_channel_info);
        }
    }
}
