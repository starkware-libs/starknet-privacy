use core::num::traits::Zero;

/// Domain-separation tags for contract hashes.
///
/// Template (stable, lowercase):
/// '<object_name>:<field_name>:v<major_version>'.
// TODO: Find good template for one felt.
pub mod domain_separation {
    /// Tags for the `EncChannel` struct.
    pub mod enc_channel {
        pub const CHANNEL_KEY_TAG: felt252 = 'enc_channel:enc_channel_key:v1';
        pub const TOKEN_TAG: felt252 = 'enc_channel:enc_token:v1';
        pub const SENDER_ADDR_TAG: felt252 = 'enc_channel:enc_sender_addr:v1';
    }
}

/// Ciphertext for an ECDH-based encryption of channel data.
#[derive(Drop, Serde, starknet::Store, PartialEq, Debug, Copy)]
pub struct EncChannel {
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
pub impl EncChannelImpl of EncChannelTrait {
    /// Check if the `EncChannel`'s fields are non-zero.
    fn is_non_zero(self: @EncChannel) -> bool {
        return self.ephemeral_pubkey.is_non_zero()
            && self.enc_channel_key.is_non_zero()
            && self.enc_token.is_non_zero()
            && self.enc_sender_addr.is_non_zero();
    }
}
