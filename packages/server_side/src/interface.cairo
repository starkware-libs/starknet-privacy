#[starknet::interface]
pub trait IServerSide<T> {
    /// Registers the caller by storing their public viewing key.
    ///
    /// #### Parameters
    /// * `public_key` - The public viewing key to associate with the caller's address. Must be a
    /// nonzero value.
    ///
    /// #### Events
    /// * [`Register`](server_side::events::Register)
    ///
    /// #### Errors
    /// * [`INVALID_PUBLIC_KEY`](server_side::errors::INVALID_PUBLIC_KEY): Thrown if the provided
    /// `public_key` is zero.
    /// * [`PUBLIC_KEY_ALREADY_EXISTS`](server_side::errors::PUBLIC_KEY_ALREADY_EXISTS): Thrown if
    /// the caller is already registered (i.e., a public key already exists for the caller).
    fn register(ref self: T, public_key: felt252);
}
