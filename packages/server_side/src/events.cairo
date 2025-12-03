pub mod Events {
    use starknet::ContractAddress;

    #[derive(Debug, Drop, PartialEq, starknet::Event)]
    pub struct Register {
        pub user: ContractAddress,
        pub viewing_key: felt252,
        pub compliance_viewing_key: felt252,
    }
}
