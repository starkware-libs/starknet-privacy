use core::num::traits::Zero;

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
    /// Tags for the `EncChannelInfo` struct.
    // TODO: Now using "channel_info" instead of "enc_channel_info" to fit in a single felt.
    pub mod enc_channel_info {
        pub const ENC_CHANNEL_KEY_TAG: felt252 = 'channel_info:enc_channel_key:v1';
        pub const ENC_TOKEN_TAG: felt252 = 'channel_info:enc_token:v1';
        pub const ENC_SENDER_ADDR_TAG: felt252 = 'channel_info:enc_sender_addr:v1';
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
