use server::objects::EncChannel;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IServer<T> {
    /// Creates a new channel for `recipient_addr`.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient. Must not be zero.
    /// - `enc_channel_info` (`EncChannel`): The encrypted channel information. Must not be zero.
    /// - `channel_hash` (`felt252`): The hash of the channel. Must not be zero.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - All inputs must not be zero.
    /// - The channel must not already exist.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`ZERO_RECIPIENT_ADDR`](server::errors::ZERO_RECIPIENT_ADDR): Thrown if `recipient_addr`
    /// is zero.
    /// - [`ZERO_ENC_CHANNEL_INFO`](server::errors::ZERO_ENC_CHANNEL_INFO): Thrown if one of the
    /// fields in `enc_channel_info` is zero.
    /// - [`ZERO_CHANNEL_HASH`](server::errors::ZERO_CHANNEL_HASH): Thrown if `channel_hash` is
    /// zero.
    /// - [`CHANNEL_ALREADY_EXISTS`](server::errors::CHANNEL_ALREADY_EXISTS): Thrown if the channel
    /// already exists.
    ///
    /// #### Access Control
    /// - TBD
    ///
    /// #### Notes
    /// - Only the sender can create a channel for a recipient.
    fn create_channel(
        ref self: T,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannel,
        channel_hash: felt252,
    );
}
