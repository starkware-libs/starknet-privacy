//! Subchannel (token channel) discovery.
//!
//! This module provides functionality to discover and decrypt subchannels
//! for a given channel key. Subchannels represent token-specific channels
//! within a channel.

use starknet_types_core::felt::Felt;

use tracing::{debug, trace};

use crate::discovery::cursor::ChannelCursor;
use crate::discovery::{DiscoveryError, COST_SUBCHANNEL_INFO};
use crate::io_budget::IoBudget;
use crate::privacy_pool::decryption::decrypt_subchannel_token;
use crate::privacy_pool::felt_hex;
use crate::privacy_pool::hashes::compute_subchannel_id;
use crate::privacy_pool::types::SecretFelt;
use crate::privacy_pool::views::IViews;

/// A discovered and decrypted subchannel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subchannel {
    /// The index of this subchannel within the channel.
    pub index: u64,
    /// The decrypted token address.
    pub token: Felt,
}

/// Result of subchannel discovery operation.
#[derive(Debug, Clone)]
pub struct SubchannelDiscoveryResult {
    /// List of discovered and decrypted subchannels.
    pub subchannels: Vec<Subchannel>,
    /// Index of the last discovered subchannel, or `None` if no subchannels were discovered.
    /// Use for cursor updates: `cursor.last_subchannel_index = result.last_index`.
    pub last_index: Option<u64>,
    /// Whether there may be more subchannels to discover.
    /// `true` if stopped due to budget exhaustion, `false` if sentinel was found.
    pub has_more: bool,
}

/// Discovers and decrypts subchannels for a given channel key.
///
/// # Algorithm
///
/// For each subchannel index starting from `start_index`:
/// 1. Compute `subchannel_id = hash(SUBCHANNEL_ID_TAG, channel_key, index, 0)`
/// 2. Fetch `EncSubchannelInfo { salt, enc_token }` from storage
/// 3. If `salt == 0`, stop (sentinel - no more subchannels)
/// 4. Decrypt: `token = enc_token - hash(ENC_TOKEN_TAG, channel_key, index, 0, salt)`
///
/// # Arguments
///
/// * `privacy_pool` - Storage backend implementing the IViews trait.
/// * `channel_key` - The channel key to discover subchannels for.
/// * `start_index` - Starting index (inclusive). For incremental discovery, pass
///   `last_index + 1` from previous result.
/// * `num_subchannels` - Maximum number of subchannels to discover. Use `usize::MAX`
///   for unlimited discovery.
/// * `budget` - I/O budget to limit storage operations.
///
/// # Returns
///
/// A `SubchannelDiscoveryResult` containing all discovered subchannels and metadata
/// for incremental discovery.
pub async fn discover_subchannels<PrivacyPool: IViews>(
    privacy_pool: &PrivacyPool,
    channel_key: &SecretFelt,
    start_index: u64,
    num_subchannels: usize,
    budget: &IoBudget,
) -> Result<SubchannelDiscoveryResult, DiscoveryError> {
    let mut subchannels = Vec::new();
    let mut index = start_index;
    let mut has_more = false;

    loop {
        // Cap reached — don't waste budget on a subchannel we won't store.
        if subchannels.len() >= num_subchannels {
            has_more = true;
            break;
        }

        // Consume budget for get_subchannel_info
        if !budget.consume(COST_SUBCHANNEL_INFO) {
            has_more = true;
            break;
        }

        let subchannel_id = compute_subchannel_id(channel_key, index);
        let encrypted = privacy_pool.get_subchannel_info(subchannel_id).await?;

        // Check for sentinel (salt == 0 means no more subchannels)
        if encrypted.salt == Felt::ZERO {
            break;
        }

        let token = decrypt_subchannel_token(&encrypted, channel_key, index);

        subchannels.push(Subchannel { index, token });
        index += 1;
    }

    let last_index = subchannels.last().map(|s| s.index);

    debug!(
        start_index,
        discovered = subchannels.len(),
        has_more,
        "discover_subchannels done"
    );
    for sc in &subchannels {
        trace!(
            index = sc.index,
            token = felt_hex(&sc.token),
            "subchannel found"
        );
    }

    Ok(SubchannelDiscoveryResult {
        subchannels,
        last_index,
        has_more,
    })
}

/// Discovers subchannels with cursor-based pagination.
///
/// If `subchannel_discovery_complete` is set in the cursor (set by the service
/// once the sentinel subchannel is reached), returns an empty vec immediately —
/// no budget consumed.
///
/// Otherwise delegates to [`discover_subchannels`], adds new subchannels to the
/// cursor, and sets `subchannel_discovery_complete` once the sentinel is found.
pub async fn discover_subchannels_paginated<S: IViews>(
    pool: &S,
    channel_key: &SecretFelt,
    cursor: &mut ChannelCursor,
    max_cursor_subchannels: usize,
    budget: &IoBudget,
) -> Result<Vec<Subchannel>, DiscoveryError> {
    // Already fully enumerated — skip entirely.
    if cursor.subchannel_discovery_complete {
        return Ok(Vec::new());
    }

    // Cap discovery to available cursor slots.
    let cursor_slots = max_cursor_subchannels.saturating_sub(cursor.subchannels.len());
    if cursor_slots == 0 {
        return Ok(Vec::new());
    }

    let start_index = cursor.last_subchannel_index.map_or(0, |i| i + 1);
    let result = discover_subchannels(pool, channel_key, start_index, cursor_slots, budget).await?;

    // Register newly discovered subchannels in the cursor.
    for sub in &result.subchannels {
        cursor.subchannels.entry(sub.token).or_default();
    }

    cursor.last_subchannel_index = result.last_index.or(cursor.last_subchannel_index);

    // Sentinel found — cache the total count.
    if !result.has_more {
        cursor.subchannel_discovery_complete = true;
    }

    Ok(result.subchannels)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::storage_backend::MockBackend;
    use crate::test_fixtures::{get_channel_key, load_devnet_fixture};

    #[tokio::test]
    async fn test_discover_no_subchannels() {
        let backend = MockBackend::empty();
        // Use a random channel key - empty backend returns zero for all slots
        let channel_key = SecretFelt::new(Felt::from_hex_unchecked("0x12345"));
        let budget = IoBudget::new(100);

        let result = discover_subchannels(&backend, &channel_key, 0, usize::MAX, &budget)
            .await
            .unwrap();

        assert_eq!(result.subchannels.len(), 0);
        assert_eq!(result.last_index, None);
        assert!(!result.has_more);
    }

    #[tokio::test]
    async fn test_discover_subchannels_alice_self_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // First discover Alice's incoming channels to get the channel key
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        // Now discover subchannels for this channel
        let budget = IoBudget::new(100);
        let result = discover_subchannels(&backend, &channel_key, 0, usize::MAX, &budget)
            .await
            .unwrap();

        assert_eq!(
            result.subchannels.len(),
            1,
            "Alice's self-channel should have 1 subchannel (STRK)"
        );
        assert_eq!(result.last_index, Some(0));
        assert!(!result.has_more);
        assert_eq!(result.subchannels[0].index, 0);
        // The subchannel token should be STRK
        assert_eq!(result.subchannels[0].token, fixture.constants.strk_token);
    }

    #[tokio::test]
    async fn test_discover_subchannels_bob_incoming_channel() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // First discover Bob's incoming channels to get the channel key
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .expect("Bob should have at least one channel");

        // Now discover subchannels for this channel
        let budget = IoBudget::new(100);
        let result = discover_subchannels(&backend, &channel_key, 0, usize::MAX, &budget)
            .await
            .unwrap();

        assert_eq!(
            result.subchannels.len(),
            1,
            "Bob's channel should have 1 subchannel (STRK)"
        );
        assert_eq!(result.last_index, Some(0));
        assert!(!result.has_more);
        assert_eq!(result.subchannels[0].index, 0);
        // The subchannel token should be STRK
        assert_eq!(result.subchannels[0].token, fixture.constants.strk_token);
    }

    #[tokio::test]
    async fn test_discover_subchannels_incremental() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // First discover Alice's incoming channels to get the channel key
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        // First discovery - should find 1 subchannel
        let budget = IoBudget::new(100);
        let result1 = discover_subchannels(&backend, &channel_key, 0, usize::MAX, &budget)
            .await
            .unwrap();
        assert_eq!(result1.subchannels.len(), 1);
        assert_eq!(result1.last_index, Some(0));
        assert!(!result1.has_more);
        let last_index = result1.last_index.unwrap();

        // Incremental discovery starting from last_index + 1 - should find 0 new subchannels
        let result2 =
            discover_subchannels(&backend, &channel_key, last_index + 1, usize::MAX, &budget)
                .await
                .unwrap();
        assert_eq!(result2.subchannels.len(), 0);
        assert_eq!(result2.last_index, None);
        assert!(!result2.has_more);
    }

    #[tokio::test]
    async fn test_discover_subchannels_out_of_budget() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        // First discover Alice's incoming channels to get the channel key
        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        // Budget exhausted before starting (COST_SUBCHANNEL_INFO = 2)
        let budget = IoBudget::new(1);
        let result = discover_subchannels(&backend, &channel_key, 0, usize::MAX, &budget)
            .await
            .unwrap();

        assert_eq!(result.subchannels.len(), 0);
        assert_eq!(result.last_index, None);
        assert!(result.has_more);
    }

    #[tokio::test]
    async fn test_paginated_full_discovery_sets_total() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .unwrap();

        let mut cursor = ChannelCursor {
            channel_key: channel_key.clone(),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: HashMap::new(),
        };

        let budget = IoBudget::new(100);
        let subs = discover_subchannels_paginated(
            &backend,
            &channel_key,
            &mut cursor,
            usize::MAX,
            &budget,
        )
        .await
        .unwrap();

        assert_eq!(subs.len(), 1, "should discover 1 subchannel (STRK)");
        assert!(
            cursor.subchannel_discovery_complete,
            "subchannel discovery should be marked complete after sentinel"
        );
        assert!(
            cursor
                .subchannels
                .contains_key(&fixture.constants.strk_token),
            "STRK subchannel should be in cursor"
        );
    }

    #[tokio::test]
    async fn test_paginated_second_call_returns_empty_with_zero_budget() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .unwrap();

        let mut cursor = ChannelCursor {
            channel_key: channel_key.clone(),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: HashMap::new(),
        };

        // First call: full discovery
        let budget = IoBudget::new(100);
        discover_subchannels_paginated(&backend, &channel_key, &mut cursor, usize::MAX, &budget)
            .await
            .unwrap();
        assert!(cursor.subchannel_discovery_complete);

        // Second call: 0 budget — should return empty immediately
        let budget = IoBudget::new(0);
        let subs = discover_subchannels_paginated(
            &backend,
            &channel_key,
            &mut cursor,
            usize::MAX,
            &budget,
        )
        .await
        .unwrap();

        assert!(subs.is_empty(), "should skip when total is cached");
        assert_eq!(budget.remaining(), 0, "no budget should be consumed");
    }

    /// Both states have an empty subchannels map, but behavior differs:
    /// - Fresh cursor (subchannel_discovery_complete=false) → discovers subchannels
    /// - Fully enumerated (subchannel_discovery_complete=true) → skips, zero budget cost
    #[tokio::test]
    async fn test_paginated_fresh_vs_fully_enumerated() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .unwrap();

        // Fresh cursor: empty map + no total → should discover subchannels
        let mut fresh = ChannelCursor {
            channel_key: channel_key.clone(),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: HashMap::new(),
        };
        let budget = IoBudget::new(100);
        let subs =
            discover_subchannels_paginated(&backend, &channel_key, &mut fresh, usize::MAX, &budget)
                .await
                .unwrap();
        assert_eq!(subs.len(), 1, "fresh cursor should discover subchannels");

        // Fully enumerated cursor: empty map + skip=true → should skip entirely
        // (simulates state after all notes processed and entries pruned)
        let mut done = ChannelCursor {
            channel_key: channel_key.clone(),
            subchannel_discovery_complete: true,
            last_subchannel_index: Some(0),
            subchannels: HashMap::new(),
        };
        let budget = IoBudget::new(100);
        let before = budget.remaining();
        let subs =
            discover_subchannels_paginated(&backend, &channel_key, &mut done, usize::MAX, &budget)
                .await
                .unwrap();
        assert!(subs.is_empty(), "enumerated cursor should skip");
        assert_eq!(budget.remaining(), before, "zero budget consumed");
    }

    #[tokio::test]
    async fn test_discover_zero_num_subchannels() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.alice_address,
            &fixture.constants.alice_viewing_key,
        )
        .await
        .expect("Alice should have at least one channel");

        let budget = IoBudget::new(100);
        let before = budget.remaining();
        let result = discover_subchannels(&backend, &channel_key, 0, 0, &budget)
            .await
            .unwrap();

        assert!(result.subchannels.is_empty());
        assert_eq!(result.last_index, None);
        // Sentinel not reached — subchannels may exist.
        assert!(result.has_more);
        assert_eq!(
            budget.remaining(),
            before,
            "no budget consumed when capped at 0"
        );
    }

    #[tokio::test]
    async fn test_paginated_cursor_full_skips_subchannel_discovery() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .unwrap();

        // Pre-fill cursor to capacity (1 entry, max = 1).
        let mut cursor = ChannelCursor {
            channel_key: channel_key.clone(),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: HashMap::from([(Felt::from(0xabc), Default::default())]),
        };

        let budget = IoBudget::new(100);
        let before = budget.remaining();
        let subs = discover_subchannels_paginated(&backend, &channel_key, &mut cursor, 1, &budget)
            .await
            .unwrap();

        assert!(subs.is_empty(), "should skip when cursor is at capacity");
        assert_eq!(budget.remaining(), before, "no budget consumed");
        assert!(
            !cursor.subchannel_discovery_complete,
            "should NOT mark complete when skipped due to capacity"
        );
    }

    #[tokio::test]
    async fn test_paginated_cursor_partial_slots_caps_subchannel_discovery() {
        let fixture = load_devnet_fixture();
        let backend = MockBackend::new(fixture.slots);

        let channel_key = get_channel_key(
            &backend,
            fixture.constants.bob_address,
            &fixture.constants.bob_viewing_key,
        )
        .await
        .unwrap();

        // 1 existing entry + max_cursor_subchannels=2 → 1 slot available.
        let mut cursor = ChannelCursor {
            channel_key: channel_key.clone(),
            subchannel_discovery_complete: false,
            last_subchannel_index: None,
            subchannels: HashMap::from([(Felt::from(0xabc), Default::default())]),
        };

        let budget = IoBudget::new(100);
        let subs = discover_subchannels_paginated(&backend, &channel_key, &mut cursor, 2, &budget)
            .await
            .unwrap();

        // Bob has 1 subchannel (STRK). With 1 slot available, we discover it
        // but hit the cap before checking the sentinel.
        assert_eq!(subs.len(), 1, "should discover up to 1 new subchannel");
        assert_eq!(subs[0].token, fixture.constants.strk_token);
        // Cap was hit before sentinel — discovery is NOT complete.
        assert!(
            !cursor.subchannel_discovery_complete,
            "should NOT mark complete when capped before sentinel"
        );
    }
}
