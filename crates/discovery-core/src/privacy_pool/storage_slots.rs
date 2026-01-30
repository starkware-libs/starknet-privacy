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
pub fn compliance_public_key() -> Felt {
    slot("compliance_public_key", &[])
}

/// Storage slot for a user's public key.
/// Cairo: `public_key: LegacyMap<ContractAddress, PublicKey>`
pub fn public_key(user_address: Felt) -> Felt {
    slot("public_key", &[user_address])
}

/// Storage slots for a user's encrypted private key.
/// Cairo: `enc_private_key: LegacyMap<ContractAddress, EncPrivateKey>`
/// EncPrivateKey has 2 fields: ephemeral_public_key and enc_private_key.
pub fn enc_private_key(user_address: Felt) -> EncPrivateKeySlots {
    let base = slot("enc_private_key", &[user_address]);
    EncPrivateKeySlots {
        ephemeral_pubkey: base,
        enc_private_key: base + Felt::ONE,
    }
}

/// Storage slot for checking if a channel exists.
/// Cairo: `channel_exists: LegacyMap<ChannelMarker, bool>`
pub fn channel_exists(channel_marker: Felt) -> Felt {
    slot("channel_exists", &[channel_marker])
}

/// Base storage address for recipient's channels Vec.
/// Cairo: `recipient_channels: LegacyMap<ContractAddress, Vec<EncChannelInfo>>`
/// The base address stores the length of the Vec.
pub fn recipient_channels_base(recipient_address: Felt) -> Felt {
    slot("recipient_channels", &[recipient_address])
}

/// Storage slots for a specific element in recipient's channels Vec.
/// Each EncChannelInfo has 3 fields stored consecutively.
pub fn recipient_channels_element(recipient_address: Felt, index: u64) -> EncChannelInfoSlots {
    let base = recipient_channels_base(recipient_address);
    let element_base = pedersen_hash(&base, &Felt::from(index));
    EncChannelInfoSlots {
        ephemeral_pubkey: element_base,
        enc_channel_key: element_base + Felt::ONE,
        enc_sender_addr: element_base + Felt::TWO,
    }
}

/// Storage slot for checking if a subchannel exists.
/// Cairo: `subchannel_exists: LegacyMap<SubchannelMarker, bool>`
pub fn subchannel_exists(subchannel_marker: Felt) -> Felt {
    slot("subchannel_exists", &[subchannel_marker])
}

/// Storage slots for encrypted subchannel info.
/// Cairo: `subchannel_tokens: Map<felt252, EncSubchannelInfo>`
/// EncSubchannelInfo has 2 fields: salt and enc_token.
pub fn subchannel_tokens(subchannel_id: Felt) -> EncSubchannelInfoSlots {
    let base = slot("subchannel_tokens", &[subchannel_id]);
    EncSubchannelInfoSlots {
        salt: base,
        enc_token: base + Felt::ONE,
    }
}

/// Storage slot for a note's existence.
/// Cairo: `notes: LegacyMap<NoteId, bool>`
pub fn notes(note_id: Felt) -> Felt {
    slot("notes", &[note_id])
}

/// Storage slot for a nullifier's existence.
/// Cairo: `nullifiers: LegacyMap<Nullifier, bool>`
pub fn nullifiers(nullifier: Felt) -> Felt {
    slot("nullifiers", &[nullifier])
}

/// All variable names are hardcoded ASCII ≤ 31 bytes, so this cannot fail.
fn slot(name: &str, keys: &[Felt]) -> Felt {
    get_storage_var_address(name, keys).expect("hardcoded storage variable name is valid ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::load_cairo_ref_fixture;

    #[test]
    fn test_storage_slots_with_cairo_vectors() {
        let f = load_cairo_ref_fixture();

        assert_eq!(
            compliance_public_key(),
            f.slots.compliance_public_key_address
        );
        assert_eq!(
            public_key(f.inputs.sender),
            f.slots.sender_public_key_address
        );
        assert_eq!(
            public_key(f.inputs.recipient),
            f.slots.recipient_public_key_address
        );

        let enc_pk = enc_private_key(f.inputs.sender);
        assert_eq!(
            enc_pk.ephemeral_pubkey,
            f.slots.enc_private_key_ephemeral_address
        );
        assert_eq!(
            enc_pk.enc_private_key,
            f.slots.enc_private_key_enc_key_address
        );

        assert_eq!(
            channel_exists(f.inputs.channel_marker),
            f.slots.channel_exists_address
        );
        assert_eq!(
            recipient_channels_base(f.inputs.recipient),
            f.slots.recipient_channels_base_address
        );
        assert_eq!(
            recipient_channels_element(f.inputs.recipient, 0).ephemeral_pubkey,
            f.slots.recipient_channels_element_address
        );

        assert_eq!(
            subchannel_exists(f.inputs.subchannel_marker),
            f.slots.subchannel_exists_address
        );

        let tokens = subchannel_tokens(f.inputs.subchannel_id);
        assert_eq!(tokens.salt, f.slots.subchannel_tokens_salt_address);
        assert_eq!(
            tokens.enc_token,
            f.slots.subchannel_tokens_enc_token_address
        );

        assert_eq!(notes(f.inputs.note_id), f.slots.notes_address);
        assert_eq!(nullifiers(f.inputs.nullifier), f.slots.nullifiers_address);
    }
}
