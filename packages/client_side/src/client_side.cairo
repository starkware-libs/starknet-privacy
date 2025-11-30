#[starknet::contract]
pub mod ClientSide {
    use client_side::errors::Errors;
    use client_side::interface::{IClientSide, Note, NoteTrait};
    use core::num::traits::Zero;
    use starknet::get_caller_address;

    #[storage]
    struct Storage { //storage variables
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState) { //constructor logic
    }

    #[abi(embed_v0)]
    pub impl ClientSideImpl of IClientSide<ContractState> {
        fn transfer(self: @ContractState, input: Span<Note>, output: Span<Note>) -> Span<felt252> {
            assert(input.len().is_non_zero(), Errors::EMPTY_TRANSFER_INPUT);
            assert(output.len().is_non_zero(), Errors::EMPTY_TRANSFER_OUTPUT);

            let caller = get_caller_address();
            let token = input[0].token();
            let mut sum_input: u256 = Zero::zero();
            let mut sum_output: u256 = Zero::zero();
            let mut output_hashes = array![];

            for note in input {
                assert(note.owner() == caller, Errors::NOTE_OWNER_MISMATCH);
                assert(note.token() == token, Errors::NOTE_TOKEN_MISMATCH);

                // TODO: Verify notes exist in backend.

                sum_input += note.amount();
            }
            for note in output {
                assert(note.token() == token, Errors::NOTE_TOKEN_MISMATCH);
                sum_output += note.amount();
                output_hashes.append(note.hash());
            }
            assert(sum_input == sum_output, Errors::NOTE_SUM_MISMATCH);

            return output_hashes.span();
        }
    }
}
