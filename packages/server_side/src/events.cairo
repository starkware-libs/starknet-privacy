pub mod Events {
    use starknet::ContractAddress;

    // TODO: Do we need to emit register event?

    #[derive(Debug, Drop, PartialEq, starknet::Event)]
    pub struct Register {
        pub user: ContractAddress,
        pub viewing_key: felt252,
        pub enc_compliance_viewing_key: felt252,
    }
}
