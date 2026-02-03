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
/// Cairo: `channel_exists: LegacyMap<ChannelMarker, bool>`
pub fn channel_exists(channel_marker: Felt) -> Result<Felt> {
    get_storage_var_address("channel_exists", &[channel_marker])
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
/// Cairo: `subchannel_exists: LegacyMap<SubchannelMarker, bool>`
pub fn subchannel_exists(subchannel_marker: Felt) -> Result<Felt> {
    get_storage_var_address("subchannel_exists", &[subchannel_marker])
        .context("failed to compute subchannel_exists storage address")
}

/// Storage slots for encrypted subchannel info.
/// Cairo: `subchannel_tokens: Map<felt252, EncSubchannelInfo>`
/// EncSubchannelInfo has 2 fields: salt and enc_token.
pub fn subchannel_tokens(subchannel_id: Felt) -> Result<EncSubchannelInfoSlots> {
    let base = get_storage_var_address("subchannel_tokens", &[subchannel_id])
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
    use crate::test_fixtures::load_cairo_ref_fixture;

    #[test]
    fn test_storage_slots_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();

        assert_eq!(
            compliance_public_key().unwrap(),
            f.slots.compliance_public_key_address
        );
        assert_eq!(
            public_key(f.inputs.sender).unwrap(),
            f.slots.sender_public_key_address
        );
        assert_eq!(
            public_key(f.inputs.recipient).unwrap(),
            f.slots.recipient_public_key_address
        );

        let enc_pk = enc_private_key(f.inputs.sender).unwrap();
        assert_eq!(
            enc_pk.ephemeral_pubkey,
            f.slots.enc_private_key_ephemeral_address
        );
        assert_eq!(
            enc_pk.enc_private_key,
            f.slots.enc_private_key_enc_key_address
        );

        assert_eq!(
            channel_exists(f.inputs.channel_marker).unwrap(),
            f.slots.channel_exists_address
        );
        assert_eq!(
            recipient_channels_base(f.inputs.recipient).unwrap(),
            f.slots.recipient_channels_base_address
        );
        assert_eq!(
            recipient_channels_element(f.inputs.recipient, 0)
                .unwrap()
                .ephemeral_pubkey,
            f.slots.recipient_channels_element_address
        );

        assert_eq!(
            subchannel_exists(f.inputs.subchannel_marker).unwrap(),
            f.slots.subchannel_exists_address
        );

        let tokens = subchannel_tokens(f.inputs.subchannel_id).unwrap();
        assert_eq!(tokens.salt, f.slots.subchannel_tokens_salt_address);
        assert_eq!(
            tokens.enc_token,
            f.slots.subchannel_tokens_enc_token_address
        );

        assert_eq!(notes(f.inputs.note_id).unwrap(), f.slots.notes_address);
        assert_eq!(
            nullifiers(f.inputs.nullifier).unwrap(),
            f.slots.nullifiers_address
        );
    }
}
