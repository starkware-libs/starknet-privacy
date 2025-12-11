use server::objects::EncChannelInfo;
use starknet::ContractAddress;

// TODO: Consider separate interface for views.

#[starknet::interface]
pub trait IServer<T> {
    // TODO: Access control.
    /// Opens a new channel for `recipient_addr`.
    ///
    /// A channel allows a sender to transfer funds to a recipient. It is one-directional and
    /// supports a single token. Only the sender can open a channel.
    /// For each recipient, the contract stores a vector of encrypted channel info, decryptable with
    /// the recipient’s private key.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient. Must not be zero.
    /// - `enc_channel_info` (`EncChannelInfo`): The encrypted channel information. Must not be
    /// zero.
    /// - `channel_id` (`felt252`): The id of the channel. Must not be zero.
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
    /// - [`ZERO_CHANNEL_ID`](server::errors::ZERO_CHANNEL_ID): Thrown if `channel_id` is
    /// zero.
    /// - [`CHANNEL_ALREADY_EXISTS`](server::errors::CHANNEL_ALREADY_EXISTS): Thrown if the channel
    /// already exists.
    ///
    /// #### Access Control
    /// - TBD
    fn open_channel(
        ref self: T,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannelInfo,
        channel_id: felt252,
    );

    /// Checks if a channel exists.
    ///
    /// #### Parameters
    /// - `channel_id` (`felt252`): The id of the channel.
    ///
    /// #### Returns
    /// (`bool`): True if the channel exists in the contract, false otherwise.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn channel_exists(self: @T, channel_id: felt252) -> bool;

    /// Returns the number of open channels for a given recipient.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient of the channels.
    ///
    /// #### Returns
    /// (`u64`): The number of the open channels for the recipient.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn get_num_of_channels(self: @T, recipient_addr: ContractAddress) -> u64;

    // TODO: add "Index out of bounds" in reverts?
    /// Returns the encrepted channel information for a given recipient and channel index.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient.
    /// - `channel_index` (`u64`): The index of the channel within the recipient's channel vector.
    ///
    /// #### Returns
    /// (`EncChannelInfo`): The encrypted channel information.
    ///
    /// #### Preconditions
    /// - `channel_index` must be a valid index within the `recipient_addr`'s channel vector.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn get_channel_info(
        self: @T, recipient_addr: ContractAddress, channel_index: u64,
    ) -> EncChannelInfo;

    /// Returns the encrypted note value for a given note id.
    ///
    /// #### Parameters
    /// - `note_id` (`felt252`): The id of the note.
    ///
    /// #### Returns
    /// (`felt252`): The encrypted note value.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn get_note(self: @T, note_id: felt252) -> felt252;

    /// Checks if a nullifier exists.
    ///
    /// #### Parameters
    /// - `nullifier` (`felt252`): The nullifier.
    ///
    /// #### Returns
    /// (`bool`): True if the nullifier exists in the contract, false otherwise.
    ///
    /// #### Preconditions
    /// None
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// None
    ///
    /// #### Access Control
    /// - Any address can call this function.
    fn nullifier_exists(self: @T, nullifier: felt252) -> bool;
}
