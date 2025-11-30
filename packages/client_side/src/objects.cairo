use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::PoseidonTrait;
use starknet::ContractAddress;

#[derive(Serde, Copy, Drop)]
pub struct NotePath {
    channel_index: usize,
    note_index: usize,
}

#[generate_trait]
pub impl NotePathImpl of NotePathTrait {
    fn new(channel_index: usize, note_index: usize) -> NotePath {
        NotePath { channel_index, note_index }
    }

    fn channel_index(self: @NotePath) -> usize {
        *self.channel_index
    }

    fn nullifier(self: @NotePath, channel_key: felt252, public_key: felt252) -> felt252 {
        PoseidonTrait::new()
            .update_with(value: channel_key)
            .update_with(value: *self.note_index)
            .update_with(value: public_key)
            .finalize()
    }
}

#[derive(Serde, Copy, Drop)]
pub struct Note {
    recipient: ContractAddress,
    recipient_public_key: felt252,
    token: ContractAddress,
    amount: u128,
}

// TODO: Consider moving to a different file.
#[generate_trait]
pub impl NoteImpl of NoteTrait {
    fn new(
        recipient: ContractAddress,
        recipient_public_key: felt252,
        token: ContractAddress,
        amount: u128,
    ) -> Note {
        Note { recipient, recipient_public_key, token, amount }
    }

    fn channel_key(self: @Note, sender: ContractAddress, sender_private_key: felt252) -> felt252 {
        PoseidonTrait::new()
            .update_with(value: sender_private_key)
            .update_with(value: *self.recipient_public_key)
            .update_with(value: sender)
            .update_with(value: *self.recipient)
            .update_with(value: *self.token)
            .finalize()
    }

    fn id(self: @Note, sender: ContractAddress, sender_private_key: felt252, i: usize) -> felt252 {
        PoseidonTrait::new()
            .update_with(value: self.channel_key(:sender, :sender_private_key))
            .update_with(value: i)
            .finalize()
    }
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct NewNote {
    id: felt252,
    amount: u128,
}

