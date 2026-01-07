#[starknet::contract]
pub mod MockAccount {
    use privacy::utils::AccountABI;
    use starknet::VALIDATED;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl MockAccountImpl of AccountABI<ContractState> {
        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            VALIDATED
        }
    }
}
