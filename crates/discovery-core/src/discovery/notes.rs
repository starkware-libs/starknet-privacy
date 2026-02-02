//! Notes discovery for a subchannel (channel_key + token pair).
//!
//! This module provides functionality to discover and decrypt notes
//! within a specific subchannel.

use starknet_types_core::felt::Felt;

use super::DiscoveryError;
use crate::decryption::{decrypt_note_amount, unpack_note_amount};
use crate::hashes::compute_note_id;
use crate::io_budget::{IoBudget, COST_NOTE};
use crate::storage::IViews;

/// A discovered and decrypted note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecryptedNote {
    /// The index of this note within the subchannel.
    pub index: u64,
    /// The note ID (storage key).
    pub note_id: Felt,
    /// The decrypted amount.
    pub amount: u128,
    /// The salt used for encryption.
    pub salt: u128,
}

/// Result of notes discovery operation.
#[derive(Debug, Clone)]
pub struct NotesDiscoveryResult {
    /// List of discovered and decrypted notes.
    pub notes: Vec<DecryptedNote>,
    /// Total number of notes discovered.
    /// Use this as `start_index` for incremental discovery.
    pub total_n_notes: u64,
}

/// Discovers and decrypts notes for a given channel key and token.
///
/// # Algorithm
///
/// For each note index starting from `start_index`:
/// 1. Compute `note_id = hash(NOTE_ID_TAG, channel_key, token, index, 0)`
/// 2. Fetch `packed_amount` from storage
/// 3. If `packed_amount == 0`, stop (sentinel - no more notes)
/// 4. Decrypt to get `(amount, salt)`
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `channel_key` - The channel key.
/// * `token` - The token address for this subchannel.
/// * `start_index` - Starting index (inclusive). For incremental discovery, pass
///   `total_n_notes` from previous result.
/// * `budget` - I/O budget to limit storage operations.
///
/// # Returns
///
/// A `NotesDiscoveryResult` containing all discovered notes and metadata
/// for incremental discovery.
pub async fn discover_notes<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    channel_key: Felt,
    token: Felt,
    start_index: u64,
    budget: &IoBudget,
) -> Result<NotesDiscoveryResult, DiscoveryError> {
    let mut notes = Vec::new();
    let mut index = start_index;

    loop {
        // Consume budget for get_note
        if budget.consume(COST_NOTE).is_none() {
            break; // Out of budget
        }

        let note_id = compute_note_id(channel_key, token, index);
        let packed_amount = privacy_pool.get_note(note_id).await?;

        // Sentinel: contract stores zero for non-existent notes
        if packed_amount == Felt::ZERO {
            break;
        }

        let (salt, enc_amount) = unpack_note_amount(packed_amount);

        // TODO: Open notes (salt == 1) store the amount in plaintext,
        // so enc_amount is already the actual amount - no decryption needed.
        let amount = decrypt_note_amount(enc_amount, salt, channel_key, token, index);

        notes.push(DecryptedNote {
            index,
            note_id,
            amount,
            salt,
        });
        index += 1;
    }

    Ok(NotesDiscoveryResult {
        notes,
        total_n_notes: index,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_backend::MockBackend;
    use crate::test_fixtures::load_devnet_fixture;

    /// Helper to discover channels and get the channel key for a recipient.
    async fn get_channel_key(
        backend: &MockBackend,
        recipient: Felt,
        viewing_key: &Felt,
    ) -> Option<Felt> {
        use crate::discovery::discover_incoming_channels;

        let budget = IoBudget::new(100);
        let result = discover_incoming_channels(backend, recipient, viewing_key, 0, &budget)
            .await
            .ok()?;

        result.channels.first().map(|c| c.info.channel_key)
    }

    /// Helper to discover subchannels and get the token for a channel.
    async fn get_subchannel_token(backend: &MockBackend, channel_key: Felt) -> Option<Felt> {
        use crate::discovery::discover_subchannels;

        let budget = IoBudget::new(100);
        let result = discover_subchannels(backend, channel_key, 0, &budget)
            .await
            .ok()?;

        result.subchannels.first().map(|s| s.token)
    }

    #[tokio::test]
    async fn test_discover_no_notes() {
        let backend = MockBackend::empty();
        let channel_key = Felt::from_hex_unchecked("0x12345");
        let token = Felt::from_hex_unchecked("0x67890");
        let budget = IoBudget::new(100);

        let result = discover_notes(&backend, channel_key, token, 0, &budget)
            .await
            .unwrap();

        assert_eq!(result.notes.len(), 0);
        assert_eq!(result.total_n_notes, 0);
    }

    #[tokio::test]
    async fn test_discover_notes_alice_self_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // Discover channel -> subchannel -> notes
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        let token = get_subchannel_token(&backend, channel_key)
            .await
            .expect("Alice's channel should have at least one subchannel");

        let budget = IoBudget::new(100);
        let result = discover_notes(&backend, channel_key, token, 0, &budget)
            .await
            .unwrap();

        assert!(
            !result.notes.is_empty(),
            "Alice's self-channel should have notes"
        );
        assert_eq!(result.total_n_notes, result.notes.len() as u64);
        assert_eq!(result.notes[0].index, 0);
        // The amount should be positive
        assert!(result.notes[0].amount > 0, "Note amount should be positive");
    }

    #[tokio::test]
    async fn test_discover_notes_bob_incoming() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // Discover Bob's incoming channel
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .expect("Bob should have at least one channel");

        let token = get_subchannel_token(&backend, channel_key)
            .await
            .expect("Bob's channel should have at least one subchannel");

        let budget = IoBudget::new(100);
        let result = discover_notes(&backend, channel_key, token, 0, &budget)
            .await
            .unwrap();

        assert!(
            !result.notes.is_empty(),
            "Bob should have received notes from Alice"
        );
        assert!(result.notes[0].amount > 0, "Note amount should be positive");
    }

    #[tokio::test]
    async fn test_discover_notes_incremental() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // Discover Alice's channel and subchannel
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        let token = get_subchannel_token(&backend, channel_key)
            .await
            .expect("Alice's channel should have at least one subchannel");

        // First discovery
        let budget = IoBudget::new(100);
        let result1 = discover_notes(&backend, channel_key, token, 0, &budget)
            .await
            .unwrap();
        assert!(!result1.notes.is_empty());

        // Incremental discovery starting from total - should find 0 new notes
        let result2 = discover_notes(&backend, channel_key, token, result1.total_n_notes, &budget)
            .await
            .unwrap();
        assert_eq!(result2.notes.len(), 0);
        assert_eq!(result2.total_n_notes, result1.total_n_notes);
    }

    #[tokio::test]
    async fn test_discover_notes_out_of_budget() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // Discover Alice's channel and subchannel
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        let token = get_subchannel_token(&backend, channel_key)
            .await
            .expect("Alice's channel should have at least one subchannel");

        // Budget exhausted before starting (COST_NOTE = 1)
        let budget = IoBudget::new(0);
        let result = discover_notes(&backend, channel_key, token, 0, &budget)
            .await
            .unwrap();

        assert_eq!(result.notes.len(), 0);
        assert_eq!(result.total_n_notes, 0);
    }
}
