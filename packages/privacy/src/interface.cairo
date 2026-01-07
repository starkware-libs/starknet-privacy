use privacy::objects::{
    ClientAction, EncChannelInfo, EncPrivateKey, EncSubchannelInfo, ServerAction,
};
use starknet::ContractAddress;

// TODO: Use same naming convention for the functions. (owner/sender,
// private_key/sender_private_key, etc).
// TODO: Remove params constraints from the Parameters section (constraints should be in the
// Preconditions section).
// TODO: Move return values to the Returns section and add links to ServerAction enum and actions
// variants.
// TODO: Fix enum varients links in the documentation.
// TODO: Remove internal errors from the documentation.
#[starknet::interface]
pub trait IClient<T> {
    /// Compiles client actions into server actions that can be executed by the server.
    ///
    /// This function processes a span of [`ClientAction`](privacy::objects::ClientAction) and
    /// compiles each action into the corresponding
    /// [`ServerAction`](privacy::objects::ServerAction)s that the server can execute. A single
    /// client action may compile to multiple server actions.
    ///
    /// Returns a span containing server actions:
    /// - For `Register`: [`WriteIfZero`](privacy::objects::ServerAction::WriteIfZero) verifies
    ///   that the caller's public key is not already registered (storage value is zero) and writes
    ///   the public key to storage.
    /// - For `ReplacePublicKey`: [`WriteIfNonZero`](privacy::objects::ServerAction::WriteIfNonZero)
    ///   verifies that the caller has already registered a public key (storage value is non-zero)
    ///   and writes the new public key to storage.
    /// - For `OpenChannel`: [`VerifyValue`](privacy::objects::ServerAction::VerifyValue) verifies
    ///   that the channel key is valid for the given sender and recipient,
    ///   [`WriteIfZero`](privacy::objects::ServerAction::WriteIfZero) verifies that the channel id
    ///   does not already exist (storage value is zero) and writes `true` to mark it as existing,
    ///   [`AppendToVec`](privacy::objects::ServerAction::AppendToVec) stores the encrypted channel
    ///   info.
    ///
    /// #### Parameters
    /// - `user_addr` (`ContractAddress`) - The address of the user executing the actions. Must not
    /// be zero.
    /// - `client_actions` (`Span<`[`ClientAction`](privacy::objects::ClientAction)`>`) - The list
    ///   of client actions to compile.
    ///
    /// #### Returns
    /// - (`Span<`[`ServerAction`](privacy::objects::ServerAction)`>`) - A span containing the
    ///   server actions compiled from the input client actions.
    ///
    /// #### Preconditions
    /// - `user_addr` must not be zero.
    /// - `Register`:
    ///   - The `user_public_key` must not be zero.
    /// - `ReplacePublicKey`:
    ///   - The `user_public_key` must not be zero.
    ///   - The caller must have already registered a public key.
    /// - `OpenChannel`:
    ///   - All inputs must be non-zero.
    ///   - The `sender_private_key` must be canonical.
    ///   - The `recipient_addr` must be registered in the server.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`ZERO_USER_ADDR`](privacy::errors::ZERO_USER_ADDR): Thrown if `user_addr` is zero.
    /// - [`ZERO_PUBLIC_KEY`](privacy::errors::ZERO_PUBLIC_KEY): Thrown if a `Register` or
    /// `ReplacePublicKey` action contains a zero public key.
    ///
    /// #### Access Control
    /// - TODO
    fn compile_client_actions(
        self: @T, user_addr: ContractAddress, client_actions: Span<ClientAction>,
    );
}

#[starknet::interface]
pub trait IServer<T> {
    // TODO: Add ZERO_VALUE in reverts.
    /// Executes a list of actions atomically.
    ///
    /// #### Parameters
    /// - `actions` (`Span<ServerAction>`): The list of actions to execute.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - TODO
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`NON_ZERO_VALUE`](privacy::errors::NON_ZERO_VALUE): Thrown if
    /// `WriteIfZero` action is executed and the value at the specified storage path already exists.
    /// - [`INSUFFICIENT_BALANCE`]: Thrown if `TransferFrom` action is executed and the sender has
    /// insufficient balance.
    /// - [`INSUFFICIENT_ALLOWANCE`]: Thrown if `TransferFrom` action is executed and the sender has
    /// insufficient allowance.
    ///
    /// #### Access Control
    /// - TODO
    fn execute_actions(ref self: T, actions: Span<ServerAction>);
}

#[starknet::interface]
pub trait IViews<T> {
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

    /// Returns the number of open channels for the given (recipient_addr, recipient_public_key)
    /// pair.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient of the channels.
    /// - `recipient_public_key` (`felt252`): The public key of the recipient to list channels for.
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
    fn get_num_of_channels(
        self: @T, recipient_addr: ContractAddress, recipient_public_key: felt252,
    ) -> u64;

    // TODO: add "Index out of bounds" in reverts?
    /// Returns the encrepted channel information for a given (recipient_addr, recipient_public_key)
    /// pair and channel index.
    ///
    /// #### Parameters
    /// - `recipient_addr` (`ContractAddress`): The address of the recipient.
    /// - `recipient_public_key` (`felt252`): The public key of the recipient to get channel info
    /// for.
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
        self: @T,
        recipient_addr: ContractAddress,
        recipient_public_key: felt252,
        channel_index: u64,
    ) -> EncChannelInfo;

    /// Checks if a subchannel exists.
    ///
    /// #### Parameters
    /// - `subchannel_id` (`felt252`): The id of the subchannel.
    ///
    /// #### Returns
    /// (`bool`): True if the subchannel exists in the contract, false otherwise.
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
    fn subchannel_exists(self: @T, subchannel_id: felt252) -> bool;

    /// Returns the encrepted subchannel information for a given subchannel key.
    ///
    /// #### Parameters
    /// - `subchannel_key` (`felt252`): The key of the subchannel.
    ///
    /// #### Returns
    /// (`EncSubchannelInfo`): The encrypted subchannel information, or a zero struct if the
    /// subchannel does not exist.
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
    fn get_subchannel_info(self: @T, subchannel_key: felt252) -> EncSubchannelInfo;

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

    fn get_enc_private_key(self: @T, user_addr: ContractAddress) -> EncPrivateKey;

    // TODO: Do we need this function?
    fn get_compliance_public_key(self: @T) -> felt252;
}
