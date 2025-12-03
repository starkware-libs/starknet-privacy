pub mod Events {
    use starknet::ContractAddress;

    #[derive(Debug, Drop, PartialEq, starknet::Event)]
    pub struct Register {
        pub user: ContractAddress,
        pub public_key: felt252,
    }
}
