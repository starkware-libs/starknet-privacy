//! Events emitted by the server contract.
//! Used to index keys, channels, notes, and nullifiers.

use server::objects::EncChannelInfo;
use starknet::ContractAddress;

#[derive(Drop, starknet::Event)]
pub struct NoteCreated {
    #[key]
    pub note_id: felt252,
    pub enc_amount: felt252,
}

#[derive(Drop, starknet::Event)]
pub struct NullifierAdded {
    #[key]
    pub nullifier: felt252,
}

#[derive(Drop, starknet::Event)]
pub struct ChannelOpened {
    #[key]
    pub channel_id: felt252,
    pub recipient: ContractAddress,
    pub enc_channel_info: EncChannelInfo,
}

#[derive(Drop, starknet::Event)]
pub struct KeyRegistered {
    #[key]
    pub public_key: felt252,
    pub user: ContractAddress,
}
