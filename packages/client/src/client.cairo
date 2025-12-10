#[starknet::contract]
pub mod Client {
    use client::errors as Errors;
    use client::interface::IClient;
    use client::objects::{EncryptedNote, NewNote, NewNoteTrait, NotePath};
    use core::num::traits::Zero;
    use starknet::ContractAddress;
    use starknet::storage::StoragePointerWriteAccess;

    #[storage]
    struct Storage {
        /// Address of the server contract.
        server: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState, server: ContractAddress) {
        assert(server.is_non_zero(), Errors::SERVER_ZERO_ADDRESS);
        self.server.write(server);
    }

    #[abi(embed_v0)]
    pub impl ClientImpl of IClient<ContractState> {
        fn transfer(
            self: @ContractState,
            owner: ContractAddress,
            private_key: felt252,
            notes_to_use: Span<NotePath>,
            notes_to_create: Span<NewNote>,
        ) -> (Span<felt252>, Span<EncryptedNote>) {
            assert(!notes_to_use.is_empty(), Errors::NO_NOTES_TO_USE);
            assert(!notes_to_create.is_empty(), Errors::NO_NOTES_TO_CREATE);

            // TODO: Verify owner signature on TX.

            let (nullifiers, consumed_sum) = self.use_notes(:owner, :private_key, :notes_to_use);
            let (new_notes, created_sum) = self.create_notes(:notes_to_create);

            // TODO: Consider multi-token support (sum per token).
            // TODO: Implement test to catch this error.
            // TODO: Verify the tokens match in all notes.
            assert(consumed_sum == created_sum, Errors::NOTE_SUM_MISMATCH);

            (nullifiers, new_notes)
        }
    }

    #[generate_trait]
    impl ClientInternalImpl of ClientInternalTrait {
        fn use_notes(
            self: @ContractState,
            owner: ContractAddress,
            private_key: felt252,
            notes_to_use: Span<NotePath>,
        ) -> (Span<felt252>, u256) {
            // TODO: Verify notes exist in server storage.
            // TODO: Sum note amounts.
            // TODO: Verify tokens match.
            // TODO: Return nullifiers span and amount sum.

            ([].span(), Zero::zero())
        }

        fn create_notes(
            self: @ContractState, notes_to_create: Span<NewNote>,
        ) -> (Span<EncryptedNote>, u256) {
            for note in notes_to_create {
                // TODO: Verify notes are sequential in server storage.
                // TODO: Sum note amounts.
                // TODO: Verify tokens match.
                assert(note.is_non_zero(), Errors::UNEXPECTED_ZERO_VALUE);
            }
            // TODO: Return new notes span and amount sum.

            ([].span(), Zero::zero())
        }
    }
}
