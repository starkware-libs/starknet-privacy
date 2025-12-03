#[starknet::interface]
pub trait IServerSide<T> {
    /// Registers a user (the caller) by storing their public viewing key and an encrypted version
    /// of their private viewing key for compliance purposes.
    ///
    /// ## Key Details
    /// - `viewing_key`: This is the public key used by the user for viewing operations.
    /// - `enc_compliance_viewing_key`: This is the user's private viewing key, encrypted with the
    /// compliance authority's public key,
    ///   allowing the authority (holding the corresponding private key) to decrypt and access the
    ///   user's private viewing key for compliance.
    ///
    /// # Arguments
    /// * `viewing_key` - The user's public viewing key.
    /// * `enc_compliance_viewing_key` - The user's private viewing key, encrypted with the
    /// compliance authority's public key.
    fn register(ref self: T, viewing_key: felt252, enc_compliance_viewing_key: felt252);
}
