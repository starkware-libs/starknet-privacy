use client::objects::{EncryptedNote, NewNote, NotePath};
use starknet::ContractAddress;

#[starknet::interface]
pub trait IClient<T> {
    /// Validates `notes_to_create` are a valid redistribution of funds from `notes_to_use`.
    ///
    /// A transfer consists of nullifying notes owned by `owner` and creating
    /// new notes for the recipients.
    /// The owner can be one of the recipients.
    ///
    /// #### Parameters
    /// * `owner` - The owner's address.
    /// * `private_key` - The owner's private key.
    /// * `notes_to_use` - The notes that are consumed as part of the transfer. Must not be empty.
    /// * `notes_to_create` - The notes that are created as a result of the transfer.
    /// Must not be empty.
    ///
    /// #### Returns
    /// * `Span<felt252>` - The nullifiers of `notes_to_use`.
    /// * `Span<EncryptedNote>` - An encrypted representation of `notes_to_create`.
    ///
    /// #### Preconditions
    /// * `owner` is registered with `private_key` in the server.
    /// * Each recipient is registered in the server.
    /// * A channel exists from `owner` to each recipient.
    /// * `notes_to_use` use valid channels and indexes.
    /// * The sum of the amounts of `notes_to_create` equals the sum of the amounts of
    /// `notes_to_use`.
    /// * All notes are in the same token.
    /// * All notes in `notes_to_create` have amounts greater than zero.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// * [`NO_NOTES_TO_USE`](client::errors::NO_NOTES_TO_USE):
    /// Thrown if `notes_to_use` is empty.
    /// * [`NO_NOTES_TO_CREATE`](client::errors::NO_NOTES_TO_CREATE):
    /// Thrown if `notes_to_create` is empty.
    /// * [`UNEXPECTED_ZERO_VALUE`](client::errors::UNEXPECTED_ZERO_VALUE):
    /// Thrown if there's a note to be created with zero as the recipient, the token, or the amount.
    /// * [`NOTE_SUM_MISMATCH`](client::errors::NOTE_SUM_MISMATCH):
    /// Thrown if there's a mismatch between the spent funds and the received funds.
    ///
    /// #### Access Control
    /// Can be called by anyone, but the transaction must be signed by `owner`.
    fn transfer(
        self: @T,
        owner: ContractAddress,
        private_key: felt252,
        notes_to_use: Span<NotePath>,
        notes_to_create: Span<NewNote>,
    ) -> (Span<felt252>, Span<EncryptedNote>);
}
