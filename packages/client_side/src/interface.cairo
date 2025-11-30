use client_side::errors::Errors;
use core::hash::{HashStateExTrait, HashStateTrait};
use core::num::traits::Zero;
use core::poseidon::PoseidonTrait;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IClientSide<T> {
    /// Transfers notes from one user to any number of different users.
    ///
    /// # Arguments
    ///
    /// * `input` - The input notes to be spent.
    /// * `output` - The output notes to be created.
    ///
    /// # Returns
    ///
    /// * `Span<felt252>` - The hashes of the output notes.
    fn transfer(self: @T, input: Span<Note>, output: Span<Note>) -> Span<felt252>;
}

#[derive(Serde, Copy, Drop, Hash)]
pub struct Note {
    owner: ContractAddress,
    token: ContractAddress,
    amount: u256,
}

#[generate_trait]
pub impl NoteImpl of NoteTrait {
    fn new(owner: ContractAddress, token: ContractAddress, amount: u256) -> Note {
        assert(amount.is_non_zero(), Errors::NOTE_AMOUNT_MUST_BE_NON_ZERO);
        assert(token.is_non_zero(), Errors::NOTE_TOKEN_ZERO_ADDRESS);
        assert(owner.is_non_zero(), Errors::NOTE_OWNER_ZERO_ADDRESS);

        Note { owner, token, amount }
    }

    fn owner(self: @Note) -> ContractAddress {
        *self.owner
    }

    fn token(self: @Note) -> ContractAddress {
        *self.token
    }

    fn amount(self: @Note) -> u256 {
        *self.amount
    }

    fn hash(self: @Note) -> felt252 {
        PoseidonTrait::new().update_with(*self).finalize()
    }
}
