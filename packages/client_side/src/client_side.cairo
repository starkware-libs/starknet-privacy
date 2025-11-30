#[starknet::contract]
pub mod ClientSide {
    use client_side::errors::Errors;
    use client_side::interface::IClientSide;
    use client_side::objects::{NewNote, Note, NotePath};
    use core::num::traits::Zero;
    use starknet::ContractAddress;
    use starknet::storage::StoragePointerWriteAccess;

    #[storage]
    struct Storage {
        server: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState, server: ContractAddress) {
        assert(server != Zero::zero(), Errors::SERVER_ZERO_ADDRESS);
        self.server.write(value: server);
    }

    #[abi(embed_v0)]
    pub impl ClientSideImpl of IClientSide<ContractState> {
        fn transfer(
            self: @ContractState,
            sender: ContractAddress,
            sender_private_key: felt252,
            to_use: Span<NotePath>,
            to_create: Span<Note>,
        ) -> (Span<felt252>, Span<NewNote>) {
            assert(!to_use.is_empty(), Errors::EMPTY_TRANSFER_INPUT);
            assert(!to_create.is_empty(), Errors::EMPTY_TRANSFER_OUTPUT);

            // TODO: Verify sender signature on TX.

            let (nullifiers, input_sum) = self.use_notes(:sender, :sender_private_key, :to_use);
            let (new_notes, output_sum) = self.create_notes(:to_create);

            // TODO: Implement multi-token support (sum per token).
            // TODO: Implement test to catch this error.
            assert(input_sum == output_sum, Errors::NOTE_SUM_MISMATCH);

            (nullifiers, new_notes)
        }
    }

    #[generate_trait]
    impl ClientSideInternalImpl of ClientSideInternalTrait {
        fn use_notes(
            self: @ContractState,
            sender: ContractAddress,
            sender_private_key: felt252,
            to_use: Span<NotePath>,
        ) -> (Span<felt252>, u256) {
            // TODO: Check notes exist and aren't nullified in server storage.
            // TODO: Check channel is owned by sender.
            // TODO: Sum note amounts.
            // TODO: Return nullifiers span and amount sum.

            ([].span(), Zero::zero())
        }

        // TODO: Change note return type to one that server receives.
        fn create_notes(self: @ContractState, to_create: Span<Note>) -> (Span<NewNote>, u256) {
            // TODO: Check notes don't exist on server storage.
            // TODO: Validate indexes on server storage.
            // TODO: Sum note amounts.
            // TODO: Return new notes span and amount sum.

            ([].span(), Zero::zero())
        }
    }
}
