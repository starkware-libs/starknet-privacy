#[starknet::interface]
pub trait IServerSide<T> {
    /// Registers the caller by storing their public viewing key.
    ///
    /// # Arguments
    /// * `public_key` - The public viewing key to associate with the caller's address. Must be a
    /// nonzero value.
    ///
    /// # Events
    /// * Emits a [`Register`](crate::Events::Register) event on successful registration.
    ///   - `user`: The address of the registered caller.
    ///   - `public_key`: The registered public key.
    ///
    /// # Errors
    /// * [`INVALID_PUBLIC_KEY`](crate::errors::INVALID_PUBLIC_KEY): Thrown if the provided
    /// `public_key` is zero.
    /// * [`PUBLIC_KEY_ALREADY_EXISTS`](crate::errors::PUBLIC_KEY_ALREADY_EXISTS): Thrown if the
    /// caller is already registered (i.e., a public key already exists for the caller).
    fn register(ref self: T, public_key: felt252);
}
