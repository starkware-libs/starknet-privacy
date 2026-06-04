//! The offline `analyze` stage (DESIGN.md §5).
//!
//! `analyze_user` recovers one user's viewing key with the auditor key, then
//! drives the hierarchical walk over the snapshot to attribute every slot the
//! user legitimately owns and sum their unspent incoming notes per token. The
//! top-level `analyze` parses the snapshot, runs that per user, then merges the
//! results: writes each slot's `kind`, accumulates per-token balances, and
//! reports the rotation tally and the anomaly set (slots left unexplained).

use std::collections::{BTreeMap, HashMap};

use discovery_core::privacy_pool::keys::{decrypt_enc_private_key, derive_public_key};
use discovery_core::privacy_pool::types::SecretFelt;
use discovery_core::privacy_pool::views::IViews;
use futures_executor::block_on;
use starknet_types_core::felt::Felt;

use crate::backend::SnapshotBackend;
use crate::error::AuditError;
use crate::owned_slots::{registration_slots, OwnedSlot};
use crate::snapshot::Snapshot;
use crate::walk::{walk_incoming_channels, walk_notes, walk_outgoing_channels, walk_subchannels};

/// `meta` key holding the on-chain auditor public key (DESIGN.md §4.3).
const AUDITOR_PUBLIC_KEY_META: &str = "auditor_public_key";
/// `users` entry kind that `analyze` attempts to attribute.
const VIEWING_KEY_USER: &str = "viewing_key";

/// Aggregate, publishable result of an audit run (no secret-derived data).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuditSummary {
    /// `viewing_key` users processed.
    pub n_users: usize,
    /// Users whose `EncPrivateKey` could not be decrypted.
    pub n_recovery_failures: usize,
    /// Users whose recovered key disagreed with their stored `public_key`.
    pub n_public_key_mismatches: usize,
    /// `EncPrivateKey` entries referencing an auditor key other than `meta`'s.
    /// Non-zero ⇒ the auditor key was rotated (unsupported, DESIGN.md §5.2).
    pub n_foreign_auditor_key_refs: usize,
    /// Explained-slot count per `kind`.
    pub kind_counts: BTreeMap<String, usize>,
    /// Non-zero slots left unexplained — the anomaly set (`kind == null`).
    pub anomaly_slots: Vec<Felt>,
}

/// Classifies every slot in the snapshot and sums unspent notes per token
/// (DESIGN.md §5). Pure and offline: parses the JSON bytes, recovers each user's
/// viewing key with `auditor_private_key`, runs the walk to attribute slots and
/// accumulate balances, then returns the updated snapshot bytes and a summary.
///
/// The async walk is driven to completion in place — the snapshot backend reads
/// never suspend, so no async runtime is involved.
pub fn analyze(
    snapshot_bytes: &[u8],
    auditor_private_key: Felt,
) -> Result<(Vec<u8>, AuditSummary), AuditError> {
    let mut snapshot = Snapshot::from_json_bytes(snapshot_bytes)?;
    let auditor_key = SecretFelt::new(auditor_private_key);

    let meta_auditor_public_key = parse_meta_felt(&snapshot, AUDITOR_PUBLIC_KEY_META)?;
    let derived = derive_public_key(&auditor_key);
    if derived != meta_auditor_public_key {
        return Err(AuditError::WrongAuditorKey {
            meta: meta_auditor_public_key,
            derived,
        });
    }

    let backend = SnapshotBackend::from_snapshot(&snapshot);
    let user_addrs: Vec<Felt> = snapshot
        .users
        .iter()
        .filter(|user| user.kind == VIEWING_KEY_USER)
        .map(|user| user.addr)
        .collect();

    let attributions = block_on(async {
        let mut attributions = Vec::with_capacity(user_addrs.len());
        for &addr in &user_addrs {
            attributions.push(analyze_user(&backend, addr, &auditor_key).await?);
        }
        Ok::<_, AuditError>(attributions)
    })?;

    let mut summary = AuditSummary {
        n_users: user_addrs.len(),
        ..Default::default()
    };
    let mut unspent_by_token: HashMap<Felt, u128> = HashMap::new();
    for attribution in &attributions {
        summary.n_recovery_failures += usize::from(attribution.recovery_failed);
        summary.n_public_key_mismatches += usize::from(attribution.public_key_mismatch);
        summary.n_foreign_auditor_key_refs +=
            usize::from(attribution.referenced_auditor_public_key != meta_auditor_public_key);
        for owned in &attribution.owned {
            snapshot.set_kind(owned.slot, owned.kind);
        }
        for (&token, &unspent) in &attribution.unspent_by_token {
            let token_total = unspent_by_token.entry(token).or_insert(0);
            *token_total = token_total.saturating_add(unspent);
        }
    }
    for (token, total) in unspent_by_token {
        snapshot.balances.insert(token, Felt::from(total));
    }

    for entry in snapshot.slots.values() {
        if let Some(kind) = &entry.kind {
            *summary.kind_counts.entry(kind.clone()).or_insert(0) += 1;
        }
    }
    summary.anomaly_slots = snapshot
        .slots
        .iter()
        .filter(|(_, entry)| entry.kind.is_none())
        .map(|(&slot, _)| slot)
        .collect();
    summary.anomaly_slots.sort();

    Ok((snapshot.to_json_bytes()?, summary))
}

fn parse_meta_felt(snapshot: &Snapshot, key: &'static str) -> Result<Felt, AuditError> {
    let raw = snapshot.meta.get(key).ok_or(AuditError::MissingMeta(key))?;
    Felt::from_hex(raw).map_err(|_| AuditError::InvalidMetaFelt(key))
}

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
        compute_channel_marker, compute_enc_private_key_hash, compute_enc_token_hash,
        compute_note_id, compute_subchannel_id, compute_subchannel_marker,
    };
    use discovery_core::privacy_pool::storage_slots;
    use discovery_core::storage_backend::MockBackend;

    use super::*;
    use crate::snapshot::User;

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

    /// Packs an open note's plaintext amount: `OPEN_NOTE_SALT·2^128 + amount`.
    fn open_note_packed(amount: u128) -> Felt {
        Felt::from(OPEN_NOTE_SALT) * Felt::from(1u128 << 64) * Felt::from(1u128 << 64)
            + Felt::from(amount)
    }

    /// Seeds the standard fixture scenario — registered recipient + one incoming
    /// channel, subchannel, and unspent open note (amount 1000) — into a fresh
    /// slots map. Returns the slots, the user address, and the note token.
    fn seed_fixture_scenario(
        f: &serde_json::Value,
        auditor_key: &SecretFelt,
    ) -> (HashMap<Felt, Felt>, Felt, Felt) {
        let user = felt(&f["inputs"]["recipient"]);
        let recovered_target = felt(&f["inputs"]["recipientPrivateKey"]);
        let stored_public_key = felt(&f["inputs"]["recipientPublicKeyDerived"]);
        let channel_key = SecretFelt::new(felt(&f["inputs"]["channelKey"]));
        let token = felt(&f["inputs"]["token"]);

        let mut slots = HashMap::new();
        seed_registration(
            &mut slots,
            user,
            recovered_target,
            auditor_key,
            stored_public_key,
        );
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
        let salt = Felt::from(0x5678_u64);
        let sub = storage_slots::subchannel_tokens(compute_subchannel_id(&channel_key, 0));
        slots.insert(sub.salt, salt);
        slots.insert(
            sub.enc_token,
            token + compute_enc_token_hash(&channel_key, 0, salt),
        );
        let note_base = storage_slots::notes(compute_note_id(&channel_key, token, 0));
        slots.insert(note_base, open_note_packed(1000));
        slots.insert(note_base + Felt::ONE, token); // open-note token slot

        // Existence markers the contract writes, so every owned slot is present.
        let sender = felt(&f["inputs"]["sender"]);
        let channel_marker = compute_channel_marker(&channel_key, sender, user, stored_public_key);
        slots.insert(storage_slots::channel_exists(channel_marker), Felt::ONE);
        let sub_marker = compute_subchannel_marker(&channel_key, user, stored_public_key, token);
        slots.insert(storage_slots::subchannel_exists(sub_marker), Felt::ONE);
        (slots, user, token)
    }

    fn snapshot_from(slots: HashMap<Felt, Felt>, users: Vec<Felt>, meta_auditor: Felt) -> Snapshot {
        let mut snapshot = Snapshot::default();
        for (slot, value) in slots {
            snapshot.insert_slot(slot, value, 0, 0);
        }
        for addr in users {
            snapshot.users.push(User {
                addr,
                kind: VIEWING_KEY_USER.to_string(),
            });
        }
        snapshot.meta.insert(
            AUDITOR_PUBLIC_KEY_META.to_string(),
            format!("{meta_auditor:#x}"),
        );
        snapshot
    }

    #[test]
    fn test_analyze_classifies_sums_and_reports_anomaly() {
        let f = fixture();
        let auditor_private_key = felt(&f["inputs"]["auditorPrivateKey"]);
        let auditor_key = SecretFelt::new(auditor_private_key);
        let (mut slots, user, token) = seed_fixture_scenario(&f, &auditor_key);
        // One non-zero slot the walk can't explain → an anomaly.
        let anomaly = Felt::from(0xdead_u64);
        slots.insert(anomaly, Felt::from(7u64));

        let snapshot = snapshot_from(slots, vec![user], derive_public_key(&auditor_key));
        let (out, summary) =
            analyze(&snapshot.to_json_bytes().unwrap(), auditor_private_key).unwrap();

        assert_eq!(summary.n_users, 1);
        assert_eq!(summary.n_recovery_failures, 0);
        assert_eq!(summary.n_public_key_mismatches, 0);
        assert_eq!(summary.n_foreign_auditor_key_refs, 0);
        assert_eq!(summary.anomaly_slots, vec![anomaly]);
        // registration(4) + channel(5) + subchannel(3) + note(2) = 14 explained.
        assert_eq!(summary.kind_counts.values().sum::<usize>(), 14);
        assert_eq!(summary.kind_counts.get("note"), Some(&1));
        assert_eq!(summary.kind_counts.get("enc_private_key"), Some(&3));

        let result = Snapshot::from_json_bytes(&out).unwrap();
        assert_eq!(result.balances.get(&token), Some(&Felt::from(1000u64)));
        assert!(result.slots[&anomaly].kind.is_none());
    }

    #[test]
    fn test_analyze_wrong_auditor_key() {
        let f = fixture();
        let auditor_key = SecretFelt::new(felt(&f["inputs"]["auditorPrivateKey"]));
        let (slots, user, _) = seed_fixture_scenario(&f, &auditor_key);
        let snapshot = snapshot_from(slots, vec![user], derive_public_key(&auditor_key));

        // A different private key derives a different public key than meta.
        let result = analyze(&snapshot.to_json_bytes().unwrap(), Felt::from(0x999_u64));
        assert!(matches!(result, Err(AuditError::WrongAuditorKey { .. })));
    }

    #[test]
    fn test_analyze_counts_recovery_failure() {
        let f = fixture();
        let auditor_private_key = felt(&f["inputs"]["auditorPrivateKey"]);
        let auditor_key = SecretFelt::new(auditor_private_key);
        // A listed user with no registration slots → recovery fails.
        let snapshot = snapshot_from(
            HashMap::new(),
            vec![Felt::from(0xfeed_u64)],
            derive_public_key(&auditor_key),
        );

        let (_, summary) =
            analyze(&snapshot.to_json_bytes().unwrap(), auditor_private_key).unwrap();
        assert_eq!(summary.n_users, 1);
        assert_eq!(summary.n_recovery_failures, 1);
    }

    #[test]
    fn test_analyze_flags_foreign_auditor_ref() {
        let f = fixture();
        let auditor_private_key = felt(&f["inputs"]["auditorPrivateKey"]);
        let auditor_key = SecretFelt::new(auditor_private_key);
        let (mut slots, user, _) = seed_fixture_scenario(&f, &auditor_key);
        // Tamper the stored auditor-key reference: recovery (ephemeral + private
        // key) still works, but the rotation tally fires on the foreign field.
        slots.insert(
            storage_slots::enc_private_key(user).auditor_public_key,
            Felt::from(0xfee1_u64),
        );
        let snapshot = snapshot_from(slots, vec![user], derive_public_key(&auditor_key));

        let (_, summary) =
            analyze(&snapshot.to_json_bytes().unwrap(), auditor_private_key).unwrap();
        assert_eq!(summary.n_foreign_auditor_key_refs, 1);
        assert_eq!(summary.n_recovery_failures, 0);
    }
}
