use server::objects::EncChannel;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IServer<T> {
    fn create_channel(
        ref self: T,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannel,
        channel_hash: felt252,
    );
}
