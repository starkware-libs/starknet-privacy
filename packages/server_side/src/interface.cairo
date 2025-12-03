#[starknet::interface]
pub trait IServerSide<T> {
    /// Registers a user (the caller) by storing their public viewing key.
    ///
    /// ## Key Details
    /// - `public_key`: This is the public key used by the user for viewing operations.
    ///
    /// # Arguments
    /// * `public_key` - The user's public viewing key.
    fn register(ref self: T, public_key: felt252);
}
