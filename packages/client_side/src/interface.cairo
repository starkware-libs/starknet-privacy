use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::PoseidonTrait;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IClientSide<T> {
    fn transfer(self: @T, input: Span<Note>, output: Span<Note>) -> Span<felt252>;
}

#[derive(Serde, Copy, Drop, Hash)]
pub(crate) struct Note {
    owner: ContractAddress,
    token: ContractAddress,
    amount: u256,
}

#[generate_trait]
pub(crate) impl NoteImpl of NoteTrait {
    fn new(owner: ContractAddress, token: ContractAddress, amount: u256) -> Note {
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
