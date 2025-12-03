#[starknet::interface]
pub trait IServerSide<T> {
    /// Registers a user (the caller) with a viewing key and a compliance (global) viewing key.
    ///
    /// # Arguments
    /// * `viewing_key` - The user's viewing key.
    /// * `compliance_viewing_key` - The user's compliance global viewing key.
    fn register(ref self: T, viewing_key: felt252, compliance_viewing_key: felt252);
}
