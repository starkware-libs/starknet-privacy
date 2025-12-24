use core::num::traits::Zero;
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

// TODO: Move to a different file?
/// Domain-separation tags for contract hashes.
///
/// Template (stable, lowercase):
/// <object_name>:<field_name>:v<major_version>'.
// TODO: Find good template for a single felt.
// TODO: Find better naming convention for tags.
pub mod domain_separation {
    /// Tag for `channel_id`.
    pub const CHANNEL_ID_TAG: felt252 = 'channel_id:v1';
    /// Tag for `channel_key`.
    pub const CHANNEL_KEY_TAG: felt252 = 'channel_key:v1';
    /// Tag for `nullifier`.
    pub const NULLIFIER_TAG: felt252 = 'nullifier:v1';
    /// Tags for the `EncChannelInfo` struct.
    // TODO: Now using "channel_info" instead of "enc_channel_info" to fit in a single felt.
    pub mod enc_channel_info {
        pub const ENC_CHANNEL_KEY_TAG: felt252 = 'channel_info:enc_channel_key:v1';
        pub const ENC_TOKEN_TAG: felt252 = 'channel_info:enc_token:v1';
        pub const ENC_SENDER_ADDR_TAG: felt252 = 'channel_info:enc_sender_addr:v1';
    }
    /// Tags for the `EncNote` struct.
    pub mod enc_note {
        pub const NOTE_ID_TAG: felt252 = 'enc_note:id:v1';
        pub const ENC_AMOUNT_TAG: felt252 = 'enc_note:enc_amount:v1';
    }
}

/// Ciphertext for an ECDH-based encryption of channel data.
#[derive(Drop, Serde, starknet::Store, PartialEq, Debug, Copy)]
pub struct EncChannelInfo {
    /// Ephemeral ECDH public key x-coordinate (rG.x). Used by the recipient to derive rK.
    pub ephemeral_pubkey: felt252,
    /// Encrypted channel key: h(domain_separation::enc_channel::CHANNEL_KEY_TAG, rK.x) +
    /// channel_key.
    pub enc_channel_key: felt252,
    /// Encrypted token address: h(domain_separation::enc_channel::TOKEN_TAG, rK.x) + token_addr.
    pub enc_token: felt252,
    /// Encrypted sender address: h(domain_separation::enc_channel::SENDER_ADDR_TAG, rK.x) +
    /// sender_addr.
    pub enc_sender_addr: felt252,
}

// TODO: Move to a different file.
#[generate_trait]
pub impl EncChannelInfoImpl of EncChannelInfoTrait {
    /// Check if the `EncChannel`'s fields are non-zero.
    fn is_non_zero(self: @EncChannelInfo) -> bool {
        return self.ephemeral_pubkey.is_non_zero()
            && self.enc_channel_key.is_non_zero()
            && self.enc_token.is_non_zero()
            && self.enc_sender_addr.is_non_zero();
    }
}

/// An encrypted note, to be written to storage.
// TODO: Consider moving to interface.
#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub struct EncNote {
    /// The note's id.
    pub id: felt252,
    /// The encrypted amount of the note.
    pub enc_amount: felt252,
}

/// An action to be executed by the server.
#[derive(Serde, Copy, Drop, Debug)]
pub enum ServerAction {
    /// Verify that a map value is zero/empty and then write to it.
    WriteIfZero: (felt252, felt252),
    /// Verify that a storage value is non-zero and then write to it.
    WriteIfNonZero: (felt252, felt252),
    /// Append a value to a vector in storage.
    AppendToVec: (ContractAddress, EncChannelInfo),
}
