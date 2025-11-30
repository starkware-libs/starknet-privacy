use core::num::traits::Zero;
use starknet::ContractAddress;

/// The path of an existing note in the server storage.
#[derive(Serde, Copy, Drop)]
pub struct NotePath {
    /// The index of the channel within the channel vector of its owner.
    channel_index: usize,
    /// The index of the note within the note vector of the channel.
    note_index: usize,
}

#[generate_trait]
pub impl NotePathImpl of NotePathTrait {
    fn new(channel_index: usize, note_index: usize) -> NotePath {
        NotePath { channel_index, note_index }
    }
}

/// A note that is created by the owner and sent to a recipient.
#[derive(Serde, Copy, Drop)]
pub struct Note {
    /// The recipient's address.
    recipient: ContractAddress,
    /// The token address.
    token: ContractAddress,
    /// The amount the note represents.
    amount: u128,
}

#[generate_trait]
pub impl NoteImpl of NoteTrait {
    fn new(recipient: ContractAddress, token: ContractAddress, amount: u128) -> Note {
        Note { recipient, token, amount }
    }

    fn is_non_zero(self: @Note) -> bool {
        self.amount.is_non_zero()
    }
}

// TODO: Move to shared package.
/// An encrypted note, to be sent in a message to the server.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct EncryptedNote {
    /// The note's id.
    id: felt252,
    /// The amount the note represents.
    // TODO: Encrypt amount.
    amount: u128,
}
