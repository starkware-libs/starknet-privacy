use starknet::ContractAddress;

/// The path of an existing note in the server storage.
#[derive(Serde, Copy, Drop)]
pub struct NotePath {
    /// The index of the channel within the owner's channel vector.
    pub channel_index: u64,
    /// The index of the note within the channel.
    // TODO: Consider changing type to u64.
    pub note_index: usize,
}

// TODO: Consider adding recipient public key.
// TODO: Remove token from input if transfer isnt possible for multiple tokens.
/// A note that is created by the owner and sent to a recipient.
#[derive(Serde, Copy, Drop)]
pub struct NewNote {
    /// The recipient's address.
    pub recipient_addr: ContractAddress,
    /// The token's address.
    pub token: ContractAddress,
    /// The amount the note represents.
    // TODO: Consider using different type.
    pub amount: u128,
    /// The index of the note within the channel.
    pub index: usize,
}
