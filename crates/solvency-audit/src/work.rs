//! Per-user attribution for the offline `analyze` stage (DESIGN.md §5.2).
//!
//! `analyze_user` recovers one user's viewing key with the auditor key, then
//! drives the hierarchical walk over the snapshot to attribute every slot the
//! user legitimately owns and sum their unspent incoming notes per token. The
//! top-level `analyze` (next change) merges these results across all users,
//! writes the slot `kind`s, and runs the rotation/anomaly checks.

use std::collections::HashMap;

use discovery_core::privacy_pool::keys::{decrypt_enc_private_key, derive_public_key};
use discovery_core::privacy_pool::types::SecretFelt;
use discovery_core::privacy_pool::views::IViews;
use starknet_types_core::felt::Felt;

use crate::error::AuditError;
use crate::owned_slots::{registration_slots, OwnedSlot};
use crate::walk::{walk_incoming_channels, walk_notes, walk_outgoing_channels, walk_subchannels};

/// What discovering a single user contributes to the audit, merged by the
/// top-level `analyze`. Holds only public/aggregate data — no recovered key, no
/// per-note amount, no slot→user link (DESIGN.md §3 confidentiality invariant).
pub struct UserAttribution {
    /// Storage slots this user owns: registration + both walks.
    pub owned: Vec<OwnedSlot>,
    /// Unspent incoming-note amounts summed per token (this user's notes only).
    pub unspent_by_token: HashMap<Felt, u128>,
    /// The `auditor_public_key` recorded in the user's `EncPrivateKey`; the
    /// orchestrator tallies any that differ from `meta.auditor_public_key`
    /// (the rotation detector).
    pub referenced_auditor_public_key: Felt,
    /// `true` when `derive_public_key(recovered) != public_key[user]` — a finding.
    /// The walks still run; discovery needs only the private key.
    pub public_key_mismatch: bool,
    /// `true` when the `EncPrivateKey` could not be decrypted (e.g. unregistered
    /// or tampered slot). Only the registration slots are attributed.
    pub recovery_failed: bool,
}

/// Recovers one user's viewing key with the auditor key, then attributes every
/// slot the user legitimately owns and sums their unspent incoming notes per
/// token (DESIGN.md §5.2-§5.3).
///
/// - **Incoming** (as recipient): channels → subchannels → notes. The only place
///   note amounts enter Σ.
/// - **Outgoing** (as sender): channels → subchannels, stopping before notes, so
///   each note is summed exactly once.
///
/// Markers are computed from the user's *stored* `public_key` (what the contract
/// used), not the key derived from the recovered private key.
pub async fn analyze_user<S: IViews>(
    pool: &S,
    user_addr: Felt,
    auditor_private_key: &SecretFelt,
) -> Result<UserAttribution, AuditError> {
    let mut owned = registration_slots(user_addr);
    let enc = pool.get_enc_private_key(user_addr).await?;
    let referenced_auditor_public_key = enc.auditor_public_key;

    let Ok(user_private_key) = decrypt_enc_private_key(&enc, auditor_private_key) else {
        return Ok(UserAttribution {
            owned,
            unspent_by_token: HashMap::new(),
            referenced_auditor_public_key,
            public_key_mismatch: false,
            recovery_failed: true,
        });
    };

    let stored_public_key = pool.get_public_key(user_addr).await?;
    let public_key_mismatch = derive_public_key(&user_private_key) != stored_public_key;

    let mut unspent_by_token: HashMap<Felt, u128> = HashMap::new();
    let channels = walk_incoming_channels(
        pool,
        user_addr,
        &user_private_key,
        stored_public_key,
        &mut owned,
    )
    .await?;
    for channel in &channels {
        let subchannels = walk_subchannels(
            pool,
            &channel.channel_key,
            user_addr,
            stored_public_key,
            &mut owned,
        )
        .await?;
        for subchannel in &subchannels {
            let unspent = walk_notes(pool, subchannel, &user_private_key, &mut owned).await?;
            let token_total = unspent_by_token.entry(subchannel.token).or_insert(0);
            *token_total = token_total.saturating_add(unspent);
        }
    }

    let outgoing = walk_outgoing_channels(pool, user_addr, &user_private_key, &mut owned).await?;
    for channel in &outgoing {
        walk_subchannels(
            pool,
            &channel.channel_key,
            channel.recipient_addr,
            channel.recipient_public_key,
            &mut owned,
        )
        .await?;
    }

    Ok(UserAttribution {
        owned,
        unspent_by_token,
        referenced_auditor_public_key,
        public_key_mismatch,
        recovery_failed: false,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use discovery_core::privacy_pool::decryption::OPEN_NOTE_SALT;
    use discovery_core::privacy_pool::hashes::{
        compute_enc_private_key_hash, compute_enc_token_hash, compute_note_id,
        compute_subchannel_id,
    };
    use discovery_core::privacy_pool::storage_slots;
    use discovery_core::storage_backend::MockBackend;

    use super::*;

    const FIXTURE: &str =
        include_str!("../../discovery-core/tests/fixtures/cairo-reference-data.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn felt(v: &serde_json::Value) -> Felt {
        Felt::from_hex(v.as_str().unwrap()).unwrap()
    }

    /// Forward-builds an `EncPrivateKey` that `decrypt_enc_private_key` recovers
    /// back to `target`. Uses ephemeral `R = G` (`ephemeral_pubkey = G.x`), so the
    /// ECDH shared x equals the auditor's public key (`(auditor_priv·G).x`).
    fn seed_registration(
        slots: &mut HashMap<Felt, Felt>,
        user: Felt,
        target: Felt,
        auditor_private_key: &SecretFelt,
        stored_public_key: Felt,
    ) {
        let auditor_public_key = derive_public_key(auditor_private_key);
        let enc = storage_slots::enc_private_key(user);
        slots.insert(enc.auditor_public_key, auditor_public_key);
        slots.insert(
            enc.ephemeral_pubkey,
            derive_public_key(&SecretFelt::new(Felt::ONE)),
        );
        slots.insert(
            enc.enc_private_key,
            target + compute_enc_private_key_hash(auditor_public_key),
        );
        slots.insert(storage_slots::public_key(user), stored_public_key);
    }

    #[tokio::test]
    async fn test_analyze_user_attributes_full_incoming_descent() {
        let f = fixture();
        let user = felt(&f["inputs"]["recipient"]);
        let auditor_key = SecretFelt::new(felt(&f["inputs"]["auditorPrivateKey"]));
        // The fixture channel decrypts with the recipient's private key; register
        // the user so the auditor recovers exactly that key. Stored public key =
        // the derived one, so the consistency check passes.
        let recovered_target = felt(&f["inputs"]["recipientPrivateKey"]);
        let recovered_key = SecretFelt::new(recovered_target);
        let stored_public_key = felt(&f["inputs"]["recipientPublicKeyDerived"]);
        let channel_key = SecretFelt::new(felt(&f["inputs"]["channelKey"]));
        let token = felt(&f["inputs"]["token"]);

        let mut slots = HashMap::new();
        seed_registration(
            &mut slots,
            user,
            recovered_target,
            &auditor_key,
            stored_public_key,
        );

        // One incoming channel at index 0 (the fixture's encrypted channel info).
        slots.insert(storage_slots::recipient_channels_base(user), Felt::ONE);
        let element = storage_slots::recipient_channels_element(user, 0);
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

        // One subchannel at index 0 carrying the fixture token.
        let salt = Felt::from(0x5678_u64);
        let sub = storage_slots::subchannel_tokens(compute_subchannel_id(&channel_key, 0));
        slots.insert(sub.salt, salt);
        slots.insert(
            sub.enc_token,
            token + compute_enc_token_hash(&channel_key, 0, salt),
        );

        // One unspent open note at index 0, amount 1000.
        let packed = Felt::from(OPEN_NOTE_SALT) * Felt::from(1u128 << 64) * Felt::from(1u128 << 64)
            + Felt::from(1000u64);
        slots.insert(
            storage_slots::notes(compute_note_id(&channel_key, token, 0)),
            packed,
        );

        let backend = MockBackend::new(slots);
        let attribution = analyze_user(&backend, user, &auditor_key).await.unwrap();

        assert!(!attribution.recovery_failed);
        assert!(!attribution.public_key_mismatch);
        assert_eq!(
            attribution.referenced_auditor_public_key,
            derive_public_key(&auditor_key)
        );
        assert_eq!(attribution.unspent_by_token.get(&token), Some(&1000));
        assert_eq!(derive_public_key(&recovered_key), stored_public_key);

        // registration(4) + channel(5) + subchannel(3) + note(2).
        assert_eq!(attribution.owned.len(), 14);
        let count = |kind: &str| attribution.owned.iter().filter(|s| s.kind == kind).count();
        assert_eq!(count("public_key"), 1);
        assert_eq!(count("enc_private_key"), 3);
        assert_eq!(count("channel_exists"), 1);
        assert_eq!(count("subchannel_exists"), 1);
        assert_eq!(count("note"), 1);
        assert_eq!(count("open_note_token"), 1);
    }

    #[tokio::test]
    async fn test_analyze_user_recovery_failure_attributes_registration_only() {
        // No registration seeded → EncPrivateKey is all-zero → ephemeral 0 fails.
        let user = Felt::from(0x456_u64);
        let backend = MockBackend::new(HashMap::new());
        let attribution = analyze_user(&backend, user, &SecretFelt::new(Felt::from(0x54321_u64)))
            .await
            .unwrap();

        assert!(attribution.recovery_failed);
        assert!(attribution.unspent_by_token.is_empty());
        assert_eq!(attribution.owned, registration_slots(user));
    }

    #[tokio::test]
    async fn test_analyze_user_flags_public_key_mismatch() {
        let f = fixture();
        let user = felt(&f["inputs"]["recipient"]);
        let auditor_key = SecretFelt::new(felt(&f["inputs"]["auditorPrivateKey"]));
        let recovered_target = felt(&f["inputs"]["userPrivateKey"]);

        // Stored public key deliberately wrong (not the derived one).
        let mut slots = HashMap::new();
        seed_registration(
            &mut slots,
            user,
            recovered_target,
            &auditor_key,
            Felt::from(0xbad_u64),
        );
        let backend = MockBackend::new(slots);

        let attribution = analyze_user(&backend, user, &auditor_key).await.unwrap();

        assert!(!attribution.recovery_failed);
        assert!(attribution.public_key_mismatch);
        // No channels/outgoing seeded → only registration slots.
        assert_eq!(attribution.owned, registration_slots(user));
    }
}
