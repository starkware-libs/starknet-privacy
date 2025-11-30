use client_side::objects::{NewNote, Note, NotePath};
use starknet::ContractAddress;

#[starknet::interface]
pub trait IClientSide<T> {
    /// Creates a message for the server to transfer funds owned by the sender
    /// to any number of recipients.
    ///
    /// #### Parameters
    /// * `sender` - The sender's address.
    /// * `sender_private_key` - The sender's private key.
    /// * `to_use` - The notes to use as input for the transfer.
    /// * `to_create` - The notes to create as output for the transfer.
    ///
    /// #### Returns
    /// * `Span<felt252>` - The nullifiers of the notes used as input for the transfer.
    /// * `Span<NewNote>` - The new notes created as output for the transfer.
    ///
    /// #### Preconditions
    /// * A channel exists from `sender` to each recipient.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// * [`EMPTY_TRANSFER_INPUT`](server_side::errors::EMPTY_TRANSFER_INPUT):
    /// Thrown if the `to_use` span is empty.
    /// * [`EMPTY_TRANSFER_OUTPUT`](server_side::errors::EMPTY_TRANSFER_OUTPUT):
    /// Thrown if the `to_create` span is empty.
    /// * [`NOTE_SUM_MISMATCH`](server_side::errors::NOTE_SUM_MISMATCH):
    /// Thrown if there's a mismatch between the spent funds and the received funds.
    ///
    /// #### Access Control
    /// Transaction must be signed by `sender`.
    fn transfer(
        self: @T,
        sender: ContractAddress,
        sender_private_key: felt252,
        to_use: Span<NotePath>,
        to_create: Span<Note>,
    ) -> (Span<felt252>, Span<NewNote>);
}
