/// Simple echo contract that returns its input arguments.
/// Used for testing the SimulatedProofProvider.

#[starknet::interface]
pub trait IEcho<TContractState> {
    /// Returns the input arguments as-is
    fn echo(self: @TContractState, a: felt252, b: felt252) -> (felt252, felt252);
}

#[starknet::contract]
pub mod Echo {
    #[storage]
    struct Storage {}

    #[abi(embed_v0)]
    impl EchoImpl of super::IEcho<ContractState> {
        fn echo(self: @ContractState, a: felt252, b: felt252) -> (felt252, felt252) {
            (a, b)
        }
    }
}
