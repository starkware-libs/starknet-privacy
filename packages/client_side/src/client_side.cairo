#[starknet::contract]
pub mod ClientSide {
    use client_side::errors as Errors;
    use client_side::interface::IClientSide;
    use client_side::objects::{EncryptedNote, NewNote, NotePath};
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
    pub impl ClientSideImpl of IClientSide<ContractState> {
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
    impl ClientSideInternalImpl of ClientSideInternalTrait {
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
                self.assert_note_valid(:note);
            }
            // TODO: Return new notes span and amount sum.

            ([].span(), Zero::zero())
        }

        fn assert_note_valid(self: @ContractState, note: @NewNote) {
            assert(note.recipient.is_non_zero(), Errors::ZERO_RECIPIENT);
            assert(note.token.is_non_zero(), Errors::ZERO_TOKEN);
            assert(note.amount.is_non_zero(), Errors::ZERO_AMOUNT);
        }
    }
}
