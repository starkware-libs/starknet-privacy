//! Hierarchical walk over a snapshot that attributes each discovered item's
//! storage slots as it goes (DESIGN.md §5.2-§5.4).
//!
//! Unlike discovery-core's `sync` (built for client note-discovery), this walk
//! keeps the on-chain index in scope at every level, which the index-dependent
//! slot addresses (`subchannel_tokens`, `recipient_channels` elements) need. It
//! reuses discovery-core's reads (`IViews`), decryption, and slot derivations;
//! only the orchestration is local, and it is deliberately simple (linear scan
//! to the sentinel — no pagination/budget) for a one-time audit of a small pool.
//!
//! This module currently covers the **incoming channels**, **subchannels**, and
//! **notes** levels; the outgoing side extends the same walk in following changes.

use discovery_core::privacy_pool::decryption::{
    decrypt_channel_info, decrypt_packed_value, decrypt_subchannel_token, OPEN_NOTE_SALT,
};
use discovery_core::privacy_pool::hashes::{
    compute_channel_marker, compute_note_id, compute_nullifier, compute_subchannel_id,
};
use discovery_core::privacy_pool::storage_slots;
use discovery_core::privacy_pool::types::SecretFelt;
use discovery_core::privacy_pool::views::IViews;
use discovery_core::storage_backend::StorageError;
use starknet_types_core::felt::Felt;

use crate::error::AuditError;
use crate::owned_slots::{note_slots, nullifier_slot, subchannel_slots, OwnedSlot};

/// An incoming channel discovered for the audited recipient.
pub struct DiscoveredChannel {
    pub channel_key: SecretFelt,
    pub sender_addr: Felt,
    /// Index of this channel in the recipient's `recipient_channels` Vec.
    pub index: u64,
}

/// Walks the recipient's incoming channels, appending each channel's owned slots
/// (`channel_length`, `channel_element` ×3, `channel_exists`) to `owned`, and
/// returns the decrypted channels for the subchannel/note levels to build on.
///
/// A channel whose encrypted info fails to decrypt is skipped (its element slots
/// are still attributed); its deeper slots, if any, surface as anomalies.
pub async fn walk_incoming_channels<S: IViews>(
    pool: &S,
    recipient: Felt,
    recipient_private_key: &SecretFelt,
    recipient_public_key: Felt,
    owned: &mut Vec<OwnedSlot>,
) -> Result<Vec<DiscoveredChannel>, StorageError> {
    let num = pool.get_num_of_channels(recipient).await?;
    if num > 0 {
        owned.push(OwnedSlot {
            slot: storage_slots::recipient_channels_base(recipient),
            kind: "channel_length",
        });
    }

    let mut channels = Vec::new();
    for index in 0..num {
        let element = storage_slots::recipient_channels_element(recipient, index);
        for slot in element.to_vec() {
            owned.push(OwnedSlot {
                slot,
                kind: "channel_element",
            });
        }

        let enc = pool.get_channel_info(recipient, index).await?;
        let Ok(info) = decrypt_channel_info(&enc, recipient_private_key) else {
            continue;
        };
        let marker = compute_channel_marker(
            &info.channel_key,
            info.sender_addr,
            recipient,
            recipient_public_key,
        );
        owned.push(OwnedSlot {
            slot: storage_slots::channel_exists(marker),
            kind: "channel_exists",
        });
        channels.push(DiscoveredChannel {
            channel_key: info.channel_key,
            sender_addr: info.sender_addr,
            index,
        });
    }
    Ok(channels)
}

/// A subchannel discovered under an incoming channel.
pub struct DiscoveredSubchannel {
    pub channel_key: SecretFelt,
    /// Index of this subchannel within its channel (`subchannel_tokens` key).
    pub index: u64,
    pub token: Felt,
}

/// Scans a channel's subchannels (`k = 0, 1, …`) up to the salt-0 sentinel,
/// appending each one's owned slots (`subchannel_tokens` ×2 + `subchannel_exists`)
/// to `owned`, and returns the decrypted subchannels for the notes level.
///
/// Subchannels are index-sequential (contract-enforced), so the first zero-salt
/// read marks the end; a subchannel planted at a non-sequential index is left
/// undiscovered on purpose, so its slots surface as anomalies (DESIGN.md §8).
pub async fn walk_subchannels<S: IViews>(
    pool: &S,
    channel: &DiscoveredChannel,
    recipient: Felt,
    recipient_public_key: Felt,
    owned: &mut Vec<OwnedSlot>,
) -> Result<Vec<DiscoveredSubchannel>, StorageError> {
    let mut subchannels = Vec::new();
    let mut index = 0u64;
    loop {
        let id = compute_subchannel_id(&channel.channel_key, index);
        let enc = pool.get_subchannel_info(id).await?;
        if enc.salt == Felt::ZERO {
            break;
        }
        let token = decrypt_subchannel_token(&enc, &channel.channel_key, index);
        owned.extend(subchannel_slots(
            &channel.channel_key,
            index,
            recipient,
            recipient_public_key,
            token,
        ));
        subchannels.push(DiscoveredSubchannel {
            channel_key: channel.channel_key.clone(),
            index,
            token,
        });
        index += 1;
    }
    Ok(subchannels)
}

/// Scans a subchannel's notes (`index = 0, 1, …`) up to the empty-note sentinel,
/// appending each note's owned slots to `owned`: the `note` base slot, the
/// `open_note_token` slot for open notes, and the `nullifier` slot for spent
/// notes. Returns the sum of *unspent* note amounts for the subchannel's token —
/// its contribution to Σ(unspent) for the balance check (DESIGN.md §5.2-§5.3).
///
/// This is the only level that feeds Σ, so notes are summed here exactly once
/// (the outgoing side stops before notes). A note is spent iff its nullifier
/// slot is set; spent notes are attributed but excluded from the sum.
pub async fn walk_notes<S: IViews>(
    pool: &S,
    subchannel: &DiscoveredSubchannel,
    owner_private_key: &SecretFelt,
    owned: &mut Vec<OwnedSlot>,
) -> Result<u128, AuditError> {
    let channel_key = &subchannel.channel_key;
    let token = subchannel.token;
    let mut unspent_total: u128 = 0;
    let mut index = 0u64;
    loop {
        let packed = pool
            .get_note_with_block(compute_note_id(channel_key, token, index))
            .await?
            .value;
        if packed == Felt::ZERO {
            break;
        }
        let (amount, salt) = decrypt_packed_value(packed, channel_key, token, index);
        owned.extend(note_slots(
            channel_key,
            token,
            index,
            salt == OPEN_NOTE_SALT,
        ));

        let nullifier = compute_nullifier(channel_key, token, index, owner_private_key);
        if pool.nullifier_exists(nullifier).await? {
            owned.push(nullifier_slot(channel_key, token, index, owner_private_key));
        } else {
            unspent_total = unspent_total
                .checked_add(amount)
                .ok_or(AuditError::NoteAmountOverflow { token, index })?;
        }
        index += 1;
    }
    Ok(unspent_total)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use discovery_core::storage_backend::MockBackend;

    use super::*;

    /// Cairo reference vectors (shared with discovery-core).
    const FIXTURE: &str =
        include_str!("../../discovery-core/tests/fixtures/cairo-reference-data.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn felt(v: &serde_json::Value) -> Felt {
        Felt::from_hex(v.as_str().unwrap()).unwrap()
    }

    #[tokio::test]
    async fn test_walk_one_real_channel_from_fixture() {
        let f = fixture();
        let recipient = felt(&f["inputs"]["recipient"]);
        let recipient_key = SecretFelt::new(felt(&f["inputs"]["recipientPrivateKey"]));
        let recipient_pub = felt(&f["inputs"]["recipientPublicKeyDerived"]);
        let expected_key = felt(&f["inputs"]["channelKey"]);
        let expected_sender = felt(&f["inputs"]["sender"]);

        // Seed: one channel, element slots = the fixture's encrypted channel info.
        let mut slots = HashMap::new();
        slots.insert(storage_slots::recipient_channels_base(recipient), Felt::ONE);
        let element = storage_slots::recipient_channels_element(recipient, 0);
        slots.insert(
            element.ephemeral_pubkey,
            felt(&f["outputs"]["encChannelEphemeralPubkey"]),
        );
        slots.insert(
            element.enc_channel_key,
            felt(&f["outputs"]["encChannelKey"]),
        );
        slots.insert(
            element.enc_sender_addr,
            felt(&f["outputs"]["encChannelSenderAddr"]),
        );
        let backend = MockBackend::new(slots);

        let mut owned = Vec::new();
        let channels = walk_incoming_channels(
            &backend,
            recipient,
            &recipient_key,
            recipient_pub,
            &mut owned,
        )
        .await
        .unwrap();

        assert_eq!(channels.len(), 1);
        assert_eq!(*channels[0].channel_key, expected_key);
        assert_eq!(channels[0].sender_addr, expected_sender);

        // length + 3 element + channel_exists marker.
        assert_eq!(owned.len(), 5);
        let marker = compute_channel_marker(
            &SecretFelt::new(expected_key),
            expected_sender,
            recipient,
            recipient_pub,
        );
        assert!(
            owned
                .iter()
                .any(|s| s.kind == "channel_exists"
                    && s.slot == storage_slots::channel_exists(marker))
        );
    }

    /// Forward-builds one subchannel's storage: `enc_token = token + enc_token_hash`
    /// (the inverse of `decrypt_subchannel_token`), so the walk decrypts it back.
    fn seed_subchannel(
        slots: &mut HashMap<Felt, Felt>,
        channel_key: &SecretFelt,
        index: u64,
        salt: Felt,
        enc_token: Felt,
    ) {
        let s = storage_slots::subchannel_tokens(compute_subchannel_id(channel_key, index));
        slots.insert(s.salt, salt);
        slots.insert(s.enc_token, enc_token);
    }

    #[tokio::test]
    async fn test_walk_subchannels_sequential_reaches_fixture_vector() {
        use discovery_core::privacy_pool::hashes::compute_enc_token_hash;

        let f = fixture();
        let channel_key = SecretFelt::new(felt(&f["inputs"]["channelKey"]));
        let recipient = felt(&f["inputs"]["recipient"]);
        // The contract computes markers from the *stored* public key, not the
        // key derived from the private key — the fixture's vector uses this one.
        let recipient_pub = felt(&f["inputs"]["recipientPublicKey"]);

        // Indices 0..=4 are filler subchannels; index 5 is the Cairo reference
        // vector (encSubchannelSalt/Token decrypt to the fixture token).
        let mut slots = HashMap::new();
        for index in 0..5u64 {
            let salt = Felt::from(0x1000_u64 + index);
            let token = Felt::from(0x100_u64 + index);
            let enc_token = token + compute_enc_token_hash(&channel_key, index, salt);
            seed_subchannel(&mut slots, &channel_key, index, salt, enc_token);
        }
        seed_subchannel(
            &mut slots,
            &channel_key,
            5,
            felt(&f["outputs"]["encSubchannelSalt"]),
            felt(&f["outputs"]["encSubchannelToken"]),
        );
        let backend = MockBackend::new(slots);

        let channel = DiscoveredChannel {
            channel_key,
            sender_addr: felt(&f["inputs"]["sender"]),
            index: 0,
        };
        let mut owned = Vec::new();
        let subchannels =
            walk_subchannels(&backend, &channel, recipient, recipient_pub, &mut owned)
                .await
                .unwrap();

        // Scan stops at the index-6 sentinel.
        assert_eq!(subchannels.len(), 6);
        assert_eq!(subchannels[5].index, 5);
        assert_eq!(subchannels[5].token, felt(&f["inputs"]["token"]));

        // 6 subchannels × (2 token slots + 1 marker).
        assert_eq!(owned.len(), 18);
        // The index-5 slots match the Cairo reference addresses.
        assert!(owned.iter().any(|s| s.kind == "subchannel_exists"
            && s.slot == felt(&f["slots"]["subchannelExistsAddress"])));
        assert!(owned.iter().any(|s| s.kind == "subchannel_tokens"
            && s.slot == felt(&f["slots"]["subchannelTokensSaltAddress"])));
        assert!(owned.iter().any(|s| s.kind == "subchannel_tokens"
            && s.slot == felt(&f["slots"]["subchannelTokensEncTokenAddress"])));
    }

    #[tokio::test]
    async fn test_walk_subchannels_none() {
        // Index-0 salt is zero (slot absent) → immediate sentinel, nothing owned.
        let backend = MockBackend::new(HashMap::new());
        let channel = DiscoveredChannel {
            channel_key: SecretFelt::new(Felt::from(0xdef_u64)),
            sender_addr: Felt::from(0x123_u64),
            index: 0,
        };
        let mut owned = Vec::new();
        let subchannels = walk_subchannels(
            &backend,
            &channel,
            Felt::from(0x456_u64),
            Felt::from(9u64),
            &mut owned,
        )
        .await
        .unwrap();

        assert!(subchannels.is_empty());
        assert!(owned.is_empty());
    }

    #[tokio::test]
    async fn test_element_slots_attributed_even_when_undecryptable() {
        let recipient = Felt::from(0x456_u64);
        // Two channels claimed, but element slots left zero → decryption fails.
        let mut slots = HashMap::new();
        slots.insert(storage_slots::recipient_channels_base(recipient), Felt::TWO);
        let backend = MockBackend::new(slots);

        let mut owned = Vec::new();
        let channels = walk_incoming_channels(
            &backend,
            recipient,
            &SecretFelt::new(Felt::from(7u64)),
            Felt::from(9u64),
            &mut owned,
        )
        .await
        .unwrap();

        assert!(channels.is_empty()); // nothing decrypts
        assert_eq!(owned.len(), 1 + 2 * 3); // length + 2 channels × 3 element slots
    }

    /// Packs an open note's plaintext amount: `packed = OPEN_NOTE_SALT·2^128 + amount`.
    fn open_note_packed(amount: u128) -> Felt {
        Felt::from(OPEN_NOTE_SALT) * Felt::from(1u128 << 64) * Felt::from(1u128 << 64)
            + Felt::from(amount)
    }

    fn seed_note(
        slots: &mut HashMap<Felt, Felt>,
        ck: &SecretFelt,
        token: Felt,
        index: u64,
        packed: Felt,
    ) {
        slots.insert(
            storage_slots::notes(compute_note_id(ck, token, index)),
            packed,
        );
    }

    #[tokio::test]
    async fn test_walk_notes_sums_unspent_and_attributes_slots() {
        let f = fixture();
        // Reference scenario: channel_key/token/index-5 note owned by the sender.
        let channel_key = SecretFelt::new(felt(&f["inputs"]["channelKey"]));
        let token = felt(&f["inputs"]["token"]);
        let owner = SecretFelt::new(felt(&f["inputs"]["senderPrivateKey"]));

        let mut slots = HashMap::new();
        // Indices 0..=4 open notes; index 1 is spent (seed its nullifier slot).
        let amounts = [100u128, 200, 300, 400, 500];
        for (index, &amount) in amounts.iter().enumerate() {
            seed_note(
                &mut slots,
                &channel_key,
                token,
                index as u64,
                open_note_packed(amount),
            );
        }
        slots.insert(
            storage_slots::nullifiers(compute_nullifier(&channel_key, token, 1, &owner)),
            Felt::ONE,
        );
        // Index 5: the Cairo reference encrypted note (decrypts to 1000), unspent.
        seed_note(
            &mut slots,
            &channel_key,
            token,
            5,
            felt(&f["outputs"]["encNoteAmount"]),
        );
        let backend = MockBackend::new(slots);

        let subchannel = DiscoveredSubchannel {
            channel_key,
            index: 0,
            token,
        };
        let mut owned = Vec::new();
        let unspent_total = walk_notes(&backend, &subchannel, &owner, &mut owned)
            .await
            .unwrap();

        // 100 + 300 + 400 + 500 (open, unspent) + 1000 (encrypted, unspent); 200 spent.
        assert_eq!(unspent_total, 2300);

        assert_eq!(owned.iter().filter(|s| s.kind == "note").count(), 6);
        assert_eq!(
            owned.iter().filter(|s| s.kind == "open_note_token").count(),
            5
        );
        assert_eq!(owned.iter().filter(|s| s.kind == "nullifier").count(), 1);
        // Index-5 note slot + index-1 nullifier slot match the Cairo references.
        assert!(owned
            .iter()
            .any(|s| s.kind == "note" && s.slot == felt(&f["slots"]["notesAddress"])));
        assert!(owned.iter().any(|s| s.kind == "nullifier"
            && s.slot
                == storage_slots::nullifiers(compute_nullifier(
                    &subchannel.channel_key,
                    token,
                    1,
                    &owner
                ))));
    }

    #[tokio::test]
    async fn test_walk_notes_none() {
        // Index-0 note value is zero (slot absent) → immediate sentinel.
        let backend = MockBackend::new(HashMap::new());
        let subchannel = DiscoveredSubchannel {
            channel_key: SecretFelt::new(Felt::from(0xdef_u64)),
            index: 0,
            token: Felt::from(0x1234_u64),
        };
        let mut owned = Vec::new();
        let unspent_total = walk_notes(
            &backend,
            &subchannel,
            &SecretFelt::new(Felt::from(7u64)),
            &mut owned,
        )
        .await
        .unwrap();

        assert_eq!(unspent_total, 0);
        assert!(owned.is_empty());
    }

    #[tokio::test]
    async fn test_walk_notes_overflow_is_surfaced_not_clamped() {
        // Two unspent open notes whose amounts sum past u128::MAX. A correct
        // snapshot can't reach this, so the audit must fail loud instead of
        // clamping Σ to u128::MAX.
        let channel_key = SecretFelt::new(Felt::from(0xdef_u64));
        let token = Felt::from(0x1234_u64);
        let owner = SecretFelt::new(Felt::from(7u64));

        let mut slots = HashMap::new();
        seed_note(
            &mut slots,
            &channel_key,
            token,
            0,
            open_note_packed(u128::MAX),
        );
        seed_note(&mut slots, &channel_key, token, 1, open_note_packed(1));
        let backend = MockBackend::new(slots);

        let subchannel = DiscoveredSubchannel {
            channel_key,
            index: 0,
            token,
        };
        let mut owned = Vec::new();
        let error = walk_notes(&backend, &subchannel, &owner, &mut owned)
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            AuditError::NoteAmountOverflow { token: t, index: 1 } if t == token
        ));
    }
}
