use client::objects::{NewNote, NotePath};
use server::objects::EncNote;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IClient<T> {
    // TODO: Re-read preconditions after implementing the create and use notes function.
    /// Validates `notes_to_create` are a valid redistribution of funds from `notes_to_use`.
    ///
    /// A transfer consists of nullifying notes owned by `owner` and creating
    /// new notes for the recipients.
    /// The owner can be one of the recipients.
    ///
    /// #### Parameters
    /// - `owner` (`ContractAddress`) - The owner's address.
    /// - `private_key` (`felt252`) - The owner's private key.
    /// - `notes_to_use` (`Span<NotePath>`) - The notes that are consumed as part of the transfer.
    /// Must not be empty.
    /// - `notes_to_create` (`Span<NewNote>`) - The notes that are created as a result of the
    /// transfer.
    /// Must not be empty.
    ///
    /// #### Returns
    /// - (`Span<felt252>`) - The nullifiers of `notes_to_use`.
    /// - (`Span<EncNote>`) - An encrypted representation of `notes_to_create`.
    ///
    /// #### Preconditions
    /// - `owner` is registered with `private_key` in the server.
    /// - Each recipient is registered in the server.
    /// - A channel exists from `owner` to each recipient.
    /// - `notes_to_use` use valid channels and indexes.
    /// - The sum of the amounts of `notes_to_create` equals the sum of the amounts of
    /// `notes_to_use`.
    /// - All notes are in the same token.
    /// - All notes in `notes_to_create` have amounts greater than zero.
    ///
    /// #### Events Emitted
    /// None
    ///
    /// #### Reverts
    /// - [`NO_NOTES_TO_USE`](client::errors::NO_NOTES_TO_USE):
    /// Thrown if `notes_to_use` is empty.
    /// - [`NO_NOTES_TO_CREATE`](client::errors::NO_NOTES_TO_CREATE):
    /// Thrown if `notes_to_create` is empty.
    /// - [`ZERO_RECIPIENT`](client::errors::ZERO_RECIPIENT):
    /// Thrown if there's a note to be created with zero as the recipient.
    /// - [`ZERO_TOKEN`](client::errors::ZERO_TOKEN):
    /// Thrown if there's a note to be created with zero as the token.
    /// - [`ZERO_AMOUNT`](client::errors::ZERO_AMOUNT):
    /// Thrown if there's a note to be created with zero as the amount.
    /// - [`NOTE_SUM_MISMATCH`](client::errors::NOTE_SUM_MISMATCH):
    /// Thrown if there's a mismatch between the spent funds and the received funds.
    ///
    /// #### Access Control
    /// - Can be called by anyone, but the transaction must be signed by `owner`.
    fn transfer(
        self: @T,
        owner: ContractAddress,
        private_key: felt252,
        notes_to_use: Span<NotePath>,
        notes_to_create: Span<NewNote>,
    ) -> (Span<felt252>, Span<EncNote>);
}
