use server::objects::{EncChannelInfo, EncNote};
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

    /// Registers the caller as a new user with the specified public viewing key.
    ///
    /// #### Parameters
    /// - `public_key` (`felt252`): The public viewing key of the user. Must not be zero.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - `public_key` must not be zero.
    /// - Caller must not have already registered a public key.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`ZERO_PUBLIC_KEY`](server::errors::ZERO_PUBLIC_KEY): Thrown if `public_key` is
    /// zero.
    /// - [`USER_ALREADY_REGISTERED`](server::errors::USER_ALREADY_REGISTERED): Thrown if the
    /// caller has already registered a public key.
    ///
    /// #### Access Control
    /// - Self-registration only.
    fn register(ref self: T, public_key: felt252);

    /// Returns the registered public viewing key of the given user address.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address whose public key is being queried.
    ///
    /// #### Returns
    /// - (`felt252`): The public key associated with the user, or zero if not registered.
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
    fn get_public_key(self: @T, user_addr: ContractAddress) -> felt252;

    /// Replaces the caller's public viewing key to a new value.
    ///
    /// **Notes that were created before updating your public key remain encrypted with the old key
    /// and are not automatically re-encrypted or migrated. These notes can only be accessed using
    /// the private key that was previously associated with your account. To use your new public
    /// key, you must open new channels.**
    ///
    /// #### Parameters
    /// - `public_key` (`felt252`): The new public viewing key. Must not be zero.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - `public_key` must not be zero.
    /// - Caller must have already registered a public key.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`ZERO_PUBLIC_KEY`](server::errors::ZERO_PUBLIC_KEY): Thrown if `public_key` is zero.
    /// - [`USER_NOT_REGISTERED`](server::errors::USER_NOT_REGISTERED): Thrown if the caller has not
    /// registered a public key.
    ///
    /// #### Access Control
    /// - Self-service only. The caller can only replace their own public key.
    fn replace_public_key(ref self: T, public_key: felt252);

    /// Deposits funds into the contract and creates a note.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`): The address of the user depositing the funds. Must not be
    /// zero.
    /// - `token` (`ContractAddress`): The address of the token to deposit. Must not be zero.
    /// - `amount` (`u128`): The amount to deposit. Must not be zero.
    /// - `note` (`EncNote`): The encrypted note to create.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - All inputs must not be zero.
    /// - The note must not already exist.
    /// - The user must have approved the contract to spend the amount.
    /// - The user must have enough balance.
    ///
    /// #### Events Emitted
    /// - TODO
    ///
    /// #### Reverts
    /// TODO: Figure out a way to link external errors.
    /// - [`ZERO_USER_ADDR`](server::errors::ZERO_USER_ADDR): Thrown if `user_addr` is zero.
    /// - [`ZERO_TOKEN`](server::errors::ZERO_TOKEN): Thrown if `token` is zero.
    /// - [`ZERO_AMOUNT`](server::errors::ZERO_AMOUNT): Thrown if `amount` is zero.
    /// - [`ZERO_NOTE_ID`](server::errors::ZERO_NOTE_ID): Thrown if `note.id` is zero.
    /// - [`ZERO_ENC_NOTE_VALUE`](server::errors::ZERO_ENC_NOTE_VALUE): Thrown if
    /// `note.enc_amount` is zero.
    /// - [`NOTE_ALREADY_EXISTS`](server::errors::NOTE_ALREADY_EXISTS): Thrown if the note already
    /// exists.
    /// - [`INSUFFICIENT_ALLOWANCE`]: Thrown if the allowance is insufficient.
    /// - [`INSUFFICIENT_BALANCE`]: Thrown if the balance is insufficient.
    ///
    /// #### Access Control
    /// - TODO
    fn deposit(
        ref self: T,
        user_addr: ContractAddress,
        token: ContractAddress,
        amount: u128,
        note: EncNote,
    );

    /// Transfers funds by nullifying existing notes and creating new ones.
    ///
    /// #### Parameters
    /// - `nullifiers` (`Span<felt252>`): The nullifiers of the notes to be spent.
    /// - `new_notes` (`Span<EncNote>`): The new encrypted notes to be created.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - `nullifiers` must not be empty.
    /// - `new_notes` must not be empty.
    /// - All nullifiers must not be zero and must not already exist.
    /// - All new notes must have non-zero fields and must not already exist.
    ///
    /// #### Events Emitted
    /// - TODO
    ///
    /// #### Reverts
    /// - [`EMPTY_NULLIFIERS`](server::errors::EMPTY_NULLIFIERS): Thrown if `nullifiers` is empty.
    /// - [`EMPTY_NEW_NOTES`](server::errors::EMPTY_NEW_NOTES): Thrown if `new_notes` is empty.
    /// - [`ZERO_NULLIFIER`](server::errors::ZERO_NULLIFIER): Thrown if a nullifier is zero.
    /// - [`NULLIFIER_ALREADY_EXISTS`](server::errors::NULLIFIER_ALREADY_EXISTS): Thrown if a
    /// nullifier already exists.
    /// - [`ZERO_NOTE_ID`](server::errors::ZERO_NOTE_ID): Thrown if a note id is zero.
    /// - [`ZERO_ENC_NOTE_VALUE`](server::errors::ZERO_ENC_NOTE_VALUE): Thrown if a note encrypted
    /// amount is zero.
    /// - [`NOTE_ALREADY_EXISTS`](server::errors::NOTE_ALREADY_EXISTS): Thrown if a note already
    /// exists.
    ///
    /// #### Access Control
    /// - TODO
    fn transfer(ref self: T, nullifiers: Span<felt252>, new_notes: Span<EncNote>);

    /// Withdraws funds from the contract and consumes a note.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient receiving the funds.
    /// Must not be zero.
    /// - `token` (`ContractAddress`): The address of the token to withdraw. Must not be zero.
    /// - `amount` (`u128`): The amount to withdraw. Must not be zero.
    /// - `nullifier` (`felt252`): The nullifier of the note to consume. Must not be zero.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - All inputs must not be zero.
    /// - The nullifier must not already exist.
    ///
    /// #### Events Emitted
    /// - TODO
    ///
    /// #### Reverts
    /// - [`ZERO_RECIPIENT_ADDR`](server::errors::ZERO_RECIPIENT_ADDR): Thrown if `recipient_addr`
    /// is zero.
    /// - [`ZERO_TOKEN`](server::errors::ZERO_TOKEN): Thrown if `token` is zero.
    /// - [`ZERO_AMOUNT`](server::errors::ZERO_AMOUNT): Thrown if `amount` is zero.
    /// - [`ZERO_NULLIFIER`](server::errors::ZERO_NULLIFIER): Thrown if `nullifier` is zero.
    /// - [`NULLIFIER_ALREADY_EXISTS`](server::errors::NULLIFIER_ALREADY_EXISTS): Thrown if the
    /// nullifier already exists.
    ///
    /// #### Access Control
    /// - TODO
    fn withdraw(
        ref self: T,
        recipient_addr: ContractAddress,
        token: ContractAddress,
        amount: u128,
        nullifier: felt252,
    );
}
