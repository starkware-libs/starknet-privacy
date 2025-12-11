use core::num::traits::Zero;

/// Domain-separation tags for contract hashes.
///
/// Template (stable, lowercase):
/// <field_name>:v<major_version>'.
// TODO: Find good template for one felt.
pub mod domain_separation {
    /// Tags for the `EncChannelInfo` struct.
    pub mod enc_channel_info {
        pub const CHANNEL_KEY_TAG: felt252 = 'enc_channel_key:v1';
        pub const TOKEN_TAG: felt252 = 'enc_token:v1';
        pub const SENDER_ADDR_TAG: felt252 = 'enc_sender_addr:v1';
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

/// An encrypted note, to be written to server storage.
#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub struct EncryptedNote {
    /// The note's id.
    pub id: felt252,
    /// The encrypted value of the note.
    pub encrypted_amount: felt252,
}
