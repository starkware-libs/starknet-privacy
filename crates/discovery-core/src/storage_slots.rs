use anyhow::{Context, Result};
use starknet_core::utils::get_storage_var_address;
use starknet_crypto::pedersen_hash;
use starknet_types_core::felt::Felt;

/// Storage slots for encrypted private key (2 consecutive slots).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncPrivateKeySlots {
    pub ephemeral_pubkey: Felt,
    pub enc_private_key: Felt,
}

/// Storage slots for encrypted channel info in recipient_channels Vec.
/// Each EncChannelInfo has 3 fields stored in consecutive slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncChannelInfoSlots {
    pub ephemeral_pubkey: Felt,
    pub enc_channel_key: Felt,
    pub enc_sender_addr: Felt,
}

/// Storage slots for encrypted subchannel info (2 consecutive slots).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncSubchannelInfoSlots {
    pub salt: Felt,
    pub enc_token: Felt,
}

/// Storage slot for the compliance public key.
/// Cairo: `compliance_public_key: PublicKey`
pub fn compliance_public_key() -> Result<Felt> {
    get_storage_var_address("compliance_public_key", &[])
        .context("failed to compute compliance_public_key storage address")
}

/// Storage slot for a user's public key.
/// Cairo: `public_key: LegacyMap<ContractAddress, PublicKey>`
pub fn public_key(user_address: Felt) -> Result<Felt> {
    get_storage_var_address("public_key", &[user_address])
        .context("failed to compute public_key storage address")
}

/// Storage slots for a user's encrypted private key.
/// Cairo: `enc_private_key: LegacyMap<ContractAddress, EncPrivateKey>`
/// EncPrivateKey has 2 fields: ephemeral_public_key and enc_private_key.
pub fn enc_private_key(user_address: Felt) -> Result<EncPrivateKeySlots> {
    let base = get_storage_var_address("enc_private_key", &[user_address])
        .context("failed to compute enc_private_key storage address")?;
    Ok(EncPrivateKeySlots {
        ephemeral_pubkey: base,
        enc_private_key: base + Felt::ONE,
    })
}

/// Storage slot for checking if a channel exists.
/// Cairo: `channel_exists: LegacyMap<ChannelId, bool>`
pub fn channel_exists(channel_id: Felt) -> Result<Felt> {
    get_storage_var_address("channel_exists", &[channel_id])
        .context("failed to compute channel_exists storage address")
}

/// Base storage address for recipient's channels Vec.
/// Cairo: `recipient_channels: LegacyMap<ContractAddress, Vec<EncChannelInfo>>`
/// The base address stores the length of the Vec.
pub fn recipient_channels_base(recipient_address: Felt) -> Result<Felt> {
    get_storage_var_address("recipient_channels", &[recipient_address])
        .context("failed to compute recipient_channels storage address")
}

/// Storage slots for a specific element in recipient's channels Vec.
/// Each EncChannelInfo has 3 fields stored consecutively.
pub fn recipient_channels_element(
    recipient_address: Felt,
    index: u64,
) -> Result<EncChannelInfoSlots> {
    let base = recipient_channels_base(recipient_address)?;
    let element_base = pedersen_hash(&base, &Felt::from(index));
    Ok(EncChannelInfoSlots {
        ephemeral_pubkey: element_base,
        enc_channel_key: element_base + Felt::ONE,
        enc_sender_addr: element_base + Felt::TWO,
    })
}

/// Storage slot for checking if a subchannel exists.
/// Cairo: `subchannel_exists: LegacyMap<SubchannelId, bool>`
pub fn subchannel_exists(subchannel_id: Felt) -> Result<Felt> {
    get_storage_var_address("subchannel_exists", &[subchannel_id])
        .context("failed to compute subchannel_exists storage address")
}

/// Storage slots for encrypted subchannel info.
/// Cairo: `subchannel_tokens: Map<felt252, EncSubchannelInfo>`
/// EncSubchannelInfo has 2 fields: salt and enc_token.
pub fn subchannel_tokens(subchannel_key: Felt) -> Result<EncSubchannelInfoSlots> {
    let base = get_storage_var_address("subchannel_tokens", &[subchannel_key])
        .context("failed to compute subchannel_tokens storage address")?;
    Ok(EncSubchannelInfoSlots {
        salt: base,
        enc_token: base + Felt::ONE,
    })
}

/// Storage slot for a note's existence.
/// Cairo: `notes: LegacyMap<NoteId, bool>`
pub fn notes(note_id: Felt) -> Result<Felt> {
    get_storage_var_address("notes", &[note_id]).context("failed to compute notes storage address")
}

/// Storage slot for a nullifier's existence.
/// Cairo: `nullifiers: LegacyMap<Nullifier, bool>`
pub fn nullifiers(nullifier: Felt) -> Result<Felt> {
    get_storage_var_address("nullifiers", &[nullifier])
        .context("failed to compute nullifiers storage address")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test vectors generated from Cairo contract using snforge.
    // To regenerate, run from the repository root:
    //   cd packages/privacy && snforge test generate_storage_slots --include-ignored
    // See: packages/privacy/src/tests/generate_reference_data.cairo

    const SENDER: Felt = Felt::from_hex_unchecked("0x123");
    const RECIPIENT: Felt = Felt::from_hex_unchecked("0x456");

    #[test]
    fn test_compliance_public_key() {
        let slot = compliance_public_key().unwrap();
        let expected = Felt::from_hex_unchecked(
            "0xf8612cacb74429aab92a1b3e95db91c6a0c6e6436b0777064ed21bb4ecb0ed",
        );
        assert_eq!(slot, expected);
    }

    #[test]
    fn test_public_key_sender() {
        let slot = public_key(SENDER).unwrap();
        let expected = Felt::from_hex_unchecked(
            "0x5935778edf7d690937af7b24298a23b064e54fcfd2e01e181ba011593a848bf",
        );
        assert_eq!(slot, expected);
    }

    #[test]
    fn test_public_key_recipient() {
        let slot = public_key(RECIPIENT).unwrap();
        let expected = Felt::from_hex_unchecked(
            "0x703dc5fd86f5987705cf14bd6c50c0e55120f37a0ecac2d8895ccd7e909e62f",
        );
        assert_eq!(slot, expected);
    }

    #[test]
    fn test_enc_private_key_ephemeral() {
        let slots = enc_private_key(SENDER).unwrap();
        let expected = Felt::from_hex_unchecked(
            "0x440935e6c56281ba4630e9e15910ccb4b8e586b78caa00aee2dab9027248aac",
        );
        assert_eq!(slots.ephemeral_pubkey, expected);
    }

    #[test]
    fn test_enc_private_key_enc_key() {
        let slots = enc_private_key(SENDER).unwrap();
        let expected = Felt::from_hex_unchecked(
            "0x440935e6c56281ba4630e9e15910ccb4b8e586b78caa00aee2dab9027248aad",
        );
        assert_eq!(slots.enc_private_key, expected);
    }

    #[test]
    fn test_recipient_channels_base() {
        let base = recipient_channels_base(RECIPIENT).unwrap();
        let expected = Felt::from_hex_unchecked(
            "0x5039a0f3a2efd831149644f87a421ded13d54721469cd2a552d761d2f523646",
        );
        assert_eq!(base, expected);
    }

    #[test]
    fn test_recipient_channels_element_0() {
        let slots = recipient_channels_element(RECIPIENT, 0).unwrap();
        let expected = Felt::from_hex_unchecked(
            "0x1964d92b29305036d5487cc7726d73ef02560413e3cb5a8358009f7651eeb6e",
        );
        assert_eq!(slots.ephemeral_pubkey, expected);
    }
}
