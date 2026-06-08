//! Forward enumeration of the storage slots a discovered object "owns", each
//! tagged with its `kind` (DESIGN.md §5.3). `analyze` calls these for every
//! discovered channel/subchannel/note/nullifier and marks the slots explained;
//! whatever is left unexplained is an anomaly.
//!
//! The enumeration is deliberately biased toward false positives: a forgotten
//! slot type shows up as a (benign) anomaly to triage, never a missed one.

use discovery_core::privacy_pool::hashes::{
    compute_channel_marker, compute_note_id, compute_nullifier, compute_outgoing_channel_id,
    compute_subchannel_id, compute_subchannel_marker,
};
use discovery_core::privacy_pool::storage_slots;
use discovery_core::privacy_pool::types::SecretFelt;
use starknet_types_core::felt::Felt;

/// A storage slot attributed to a discovered object, tagged with its type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedSlot {
    pub slot: Felt,
    pub kind: &'static str,
}

fn owned(slot: Felt, kind: &'static str) -> OwnedSlot {
    OwnedSlot { slot, kind }
}

fn tagged(slots: Vec<Felt>, kind: &'static str) -> impl Iterator<Item = OwnedSlot> {
    slots.into_iter().map(move |slot| owned(slot, kind))
}

/// Note slots: the packed value, plus the token slot for open notes (encrypted
/// notes leave the token slot zero, so only open notes own it).
pub fn note_slots(channel_key: &SecretFelt, token: Felt, index: u64, open: bool) -> Vec<OwnedSlot> {
    let base = storage_slots::notes(compute_note_id(channel_key, token, index));
    let mut slots = vec![owned(base, "note")];
    if open {
        slots.push(owned(base + Felt::ONE, "open_note_token"));
    }
    slots
}

/// The nullifier slot for a spent note.
pub fn nullifier_slot(
    channel_key: &SecretFelt,
    token: Felt,
    index: u64,
    owner_private_key: &SecretFelt,
) -> OwnedSlot {
    let nullifier = compute_nullifier(channel_key, token, index, owner_private_key);
    owned(storage_slots::nullifiers(nullifier), "nullifier")
}

/// Subchannel slots: the encrypted token info (2 felts) and the existence marker.
pub fn subchannel_slots(
    channel_key: &SecretFelt,
    index: u64,
    recipient_addr: Felt,
    recipient_public_key: Felt,
    token: Felt,
) -> Vec<OwnedSlot> {
    let id = compute_subchannel_id(channel_key, index);
    let marker =
        compute_subchannel_marker(channel_key, recipient_addr, recipient_public_key, token);
    let mut slots: Vec<OwnedSlot> = tagged(
        storage_slots::subchannel_tokens(id).to_vec(),
        "subchannel_tokens",
    )
    .collect();
    slots.push(owned(
        storage_slots::subchannel_exists(marker),
        "subchannel_exists",
    ));
    slots
}

/// Incoming-channel slots (recipient side): the Vec length slot, the appended
/// encrypted channel-info element (3 felts), and the existence marker.
pub fn incoming_channel_slots(
    recipient_addr: Felt,
    channel_index: u64,
    channel_key: &SecretFelt,
    sender_addr: Felt,
    recipient_public_key: Felt,
) -> Vec<OwnedSlot> {
    let mut slots = vec![owned(
        storage_slots::recipient_channels_base(recipient_addr),
        "channel_length",
    )];
    slots.extend(tagged(
        storage_slots::recipient_channels_element(recipient_addr, channel_index).to_vec(),
        "channel_element",
    ));
    let marker = compute_channel_marker(
        channel_key,
        sender_addr,
        recipient_addr,
        recipient_public_key,
    );
    slots.push(owned(
        storage_slots::channel_exists(marker),
        "channel_exists",
    ));
    slots
}

/// Outgoing-channel slots (sender side): the encrypted recipient info (2 felts)
/// and the (shared) existence marker.
pub fn outgoing_channel_slots(
    sender_addr: Felt,
    sender_private_key: &SecretFelt,
    index: u64,
    channel_key: &SecretFelt,
    recipient_addr: Felt,
    recipient_public_key: Felt,
) -> Vec<OwnedSlot> {
    let id = compute_outgoing_channel_id(sender_addr, sender_private_key, index);
    let mut slots: Vec<OwnedSlot> = tagged(
        storage_slots::outgoing_channels(id).to_vec(),
        "outgoing_channel",
    )
    .collect();
    let marker = compute_channel_marker(
        channel_key,
        sender_addr,
        recipient_addr,
        recipient_public_key,
    );
    slots.push(owned(
        storage_slots::channel_exists(marker),
        "channel_exists",
    ));
    slots
}

/// Registration slots for a known user: `public_key` (1) + `enc_private_key` (3).
pub fn registration_slots(user_addr: Felt) -> Vec<OwnedSlot> {
    let mut slots = vec![owned(storage_slots::public_key(user_addr), "public_key")];
    slots.extend(tagged(
        storage_slots::enc_private_key(user_addr).to_vec(),
        "enc_private_key",
    ));
    slots
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel_key() -> SecretFelt {
        SecretFelt::new(Felt::from(0xC0FFEE_u64))
    }

    #[test]
    fn test_note_slots_encrypted_vs_open() {
        let token = Felt::from(0x1234_u64);
        let base = storage_slots::notes(compute_note_id(&channel_key(), token, 3));

        let encrypted = note_slots(&channel_key(), token, 3, false);
        assert_eq!(encrypted, vec![owned(base, "note")]);

        let open = note_slots(&channel_key(), token, 3, true);
        assert_eq!(
            open,
            vec![
                owned(base, "note"),
                owned(base + Felt::ONE, "open_note_token")
            ]
        );
    }

    #[test]
    fn test_nullifier_slot_matches_derivation() {
        let token = Felt::from(0x1234_u64);
        let owner = SecretFelt::new(Felt::from(0x888_u64));
        let expected =
            storage_slots::nullifiers(compute_nullifier(&channel_key(), token, 5, &owner));
        assert_eq!(
            nullifier_slot(&channel_key(), token, 5, &owner),
            owned(expected, "nullifier")
        );
    }

    #[test]
    fn test_subchannel_slots_shape() {
        let slots = subchannel_slots(
            &channel_key(),
            0,
            Felt::from(1u64),
            Felt::from(2u64),
            Felt::from(0x1234_u64),
        );
        assert_eq!(slots.len(), 3); // salt + enc_token + marker
        assert_eq!(
            slots
                .iter()
                .filter(|s| s.kind == "subchannel_tokens")
                .count(),
            2
        );
        assert_eq!(slots[2].kind, "subchannel_exists");
    }

    #[test]
    fn test_incoming_channel_slots_shape() {
        let slots = incoming_channel_slots(
            Felt::from(0x456_u64),
            0,
            &channel_key(),
            Felt::from(0x123_u64),
            Felt::from(0xabc_u64),
        );
        assert_eq!(slots.len(), 5); // length + 3 element + marker
        assert_eq!(slots[0].kind, "channel_length");
        assert_eq!(
            slots.iter().filter(|s| s.kind == "channel_element").count(),
            3
        );
        assert_eq!(slots[4].kind, "channel_exists");
    }

    #[test]
    fn test_registration_slots_shape() {
        let slots = registration_slots(Felt::from(0x999_u64));
        assert_eq!(slots.len(), 4); // public_key + 3 enc_private_key
        assert_eq!(slots[0].kind, "public_key");
        assert_eq!(
            slots.iter().filter(|s| s.kind == "enc_private_key").count(),
            3
        );
    }
}
