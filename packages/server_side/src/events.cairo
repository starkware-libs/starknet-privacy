use starknet::ContractAddress;

/// Emitted when a new user is registered.
#[derive(Debug, Drop, PartialEq, starknet::Event)]
pub struct Register {
    /// The address of the registered user.
    pub user: ContractAddress,
    /// The registered public viewing key.
    pub public_key: felt252,
}
