//! Test-only stand-in for the privacy pool, covering exactly the surface the
//! anonymizer touches: `IViews::get_note` and `IServer::deposit_to_open_note`.
//!
//! Both method names match the real pool's so the anonymizer's
//! `IServerDispatcher` / `IViewsDispatcher` find them by selector with no
//! configuration. The mock additionally exposes `set_note` (programmable
//! `get_note` returns) and `deposited_amount` (for post-call assertions).
//!
//! The mock enforces the same `caller == note.depositor` rule as the real
//! pool, so a mis-pointed depositor in tests reverts loudly the same way it
//! would on Sepolia.

use privacy::objects::Note;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockPool<T> {
    // ---- Mirrors of the real pool's surface ----
    fn get_note(self: @T, note_id: felt252) -> Note;
    fn deposit_to_open_note(
        ref self: T, note_id: felt252, token: ContractAddress, amount: u128,
    );

    // ---- Test-only setup + introspection ----
    fn set_note(ref self: T, note_id: felt252, note: Note);
    fn deposited_amount(self: @T, note_id: felt252) -> u128;
}

pub mod errors {
    pub const NOTE_NOT_FOUND: felt252 = 'MOCK_NOTE_NOT_FOUND';
    pub const TOKEN_MISMATCH: felt252 = 'MOCK_TOKEN_MISMATCH';
    pub const CALLER_NOT_DEPOSITOR: felt252 = 'MOCK_CALLER_NOT_DEPOSITOR';
    pub const ALREADY_DEPOSITED: felt252 = 'MOCK_ALREADY_DEPOSITED';
}

#[starknet::contract]
pub mod MockPool {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::Note;
    use starknet::storage::{Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IMockPool, errors};

    #[storage]
    struct Storage {
        notes: Map<felt252, Note>,
        deposited: Map<felt252, u128>,
    }

    #[abi(embed_v0)]
    pub impl Impl of IMockPool<ContractState> {
        fn get_note(self: @ContractState, note_id: felt252) -> Note {
            self.notes.entry(note_id).read()
        }

        fn deposit_to_open_note(
            ref self: ContractState, note_id: felt252, token: ContractAddress, amount: u128,
        ) {
            let note = self.notes.entry(note_id).read();
            assert(note.token.is_non_zero(), errors::NOTE_NOT_FOUND);
            assert(token == note.token, errors::TOKEN_MISMATCH);
            assert(get_caller_address() == note.depositor, errors::CALLER_NOT_DEPOSITOR);

            let already = self.deposited.entry(note_id).read();
            assert(already.is_zero(), errors::ALREADY_DEPOSITED);

            // Mirror the real pool: pull funds from the depositor (= caller).
            IERC20Dispatcher { contract_address: token }
                .transfer_from(
                    sender: get_caller_address(),
                    recipient: get_contract_address(),
                    amount: amount.into(),
                );

            self.deposited.entry(note_id).write(amount);
        }

        fn set_note(ref self: ContractState, note_id: felt252, note: Note) {
            self.notes.entry(note_id).write(note);
        }

        fn deposited_amount(self: @ContractState, note_id: felt252) -> u128 {
            self.deposited.entry(note_id).read()
        }
    }
}
