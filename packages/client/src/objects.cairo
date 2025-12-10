use core::num::traits::Zero;
use starknet::ContractAddress;

/// The path of an existing note in the server storage.
#[derive(Serde, Copy, Drop)]
pub struct NotePath {
    /// The index of the channel within the owner's channel vector.
    pub channel_index: usize,
    /// The index of the note within the channel.
    pub note_index: usize,
}

/// A note that is created by the owner and sent to a recipient.
#[derive(Serde, Copy, Drop)]
pub struct NewNote {
    /// The recipient's address.
    pub recipient: ContractAddress,
    /// The token's address.
    pub token: ContractAddress,
    /// The amount the note represents.
    // TODO: Consider using different type.
    pub amount: u128,
}

#[generate_trait]
pub impl NewNoteImpl of NewNoteTrait {
    fn is_non_zero(self: @NewNote) -> bool {
        self.recipient.is_non_zero() && self.token.is_non_zero() && self.amount.is_non_zero()
    }
}

// TODO: Move to server package.
/// An encrypted note, to be sent to the server.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct EncryptedNote {
    /// The note's id.
    id: felt252,
    /// The encrypted value of the note.
    encrypted_amount: felt252,
}
