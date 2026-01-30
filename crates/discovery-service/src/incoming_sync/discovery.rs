//! Concurrent discovery logic for incoming channels, subchannels, and notes.
//!
//! This module implements hierarchical discovery with concurrency via JoinSet.
//! Backpressure is handled by the RPC connection pool's ConcurrencyLimitLayer.

use std::collections::HashMap;

use discovery_core::discovery::incoming_channels::{
    discover_incoming_channels, get_incoming_channel_count,
};
use discovery_core::discovery::notes::discover_notes;
use discovery_core::discovery::subchannels::discover_subchannels;
use discovery_core::discovery::DiscoveryError;
use discovery_core::io_budget::IoBudget;
use discovery_core::storage::IViews;
use starknet_core::types::Felt;
use tokio::task::JoinSet;

use super::types::{
    ChannelCursor, ChannelResult, IncomingSyncCursor, NoteResult, SubchannelCursor,
    SubchannelResult,
};

/// Output from the discovery process.
pub struct DiscoveryOutput {
    /// Discovered channel results, keyed by channel_key.
    pub channels: HashMap<Felt, ChannelResult>,
    /// True if all channels have been discovered.
    pub channels_done: bool,
    /// Updated cursor for continuation.
    pub cursor: IncomingSyncCursor,
}

/// Result of discovering content for a single channel.
struct ChannelDiscovery {
    /// Channel key.
    channel_key: Felt,
    /// Channel result (sender_addr, subchannels_done, subchannels).
    result: ChannelResult,
    /// Updated channel cursor.
    cursor: ChannelCursor,
}

/// Runs hierarchical discovery: channels → subchannels → notes.
///
/// # Concurrency Model
///
/// Channel discovery is sequential (need total count first).
/// Subchannels and notes are discovered concurrently via JoinSet.
///
/// Tasks are spawned freely. Backpressure is handled by the RPC
/// connection pool's ConcurrencyLimitLayer (tower), which queues requests
/// when all connections are busy.
///
/// This is simpler and more efficient than task-level semaphores because:
/// - The connection pool already enforces the real bottleneck (RPC connections)
/// - Task-level limits would just duplicate this, adding memory overhead
/// - IoBudget already caps total work per request
///
/// # Future: Task-Level Semaphore
///
/// If memory becomes a concern (e.g., thousands of channels creating thousands
/// of waiting futures), add a semaphore:
///
/// ```ignore
/// let semaphore = Arc::new(Semaphore::new(config.max_tasks));
/// for channel in channels {
///     let permit = semaphore.clone().acquire_owned().await?;
///     join_set.spawn(async move {
///         let _permit = permit;
///         discover_channel_content(...).await
///     });
/// }
/// ```
///
/// Rule of thumb: max_tasks <= max_concurrent_rpc_requests / expected_concurrent_api_requests
pub async fn run_discovery<S>(
    snapshot: S,
    recipient: Felt,
    decryption_key: Felt,
    cursor: IncomingSyncCursor,
    budget: IoBudget,
) -> Result<DiscoveryOutput, DiscoveryError>
where
    S: IViews + Clone + Send + Sync + 'static,
{
    let mut output_cursor = cursor.clone();

    // 1. Get channel count (from cursor cache or by querying)
    let total_n_channels = match cursor.total_n_channels {
        Some(count) => count,
        None => {
            match get_incoming_channel_count(&snapshot, recipient, &budget).await? {
                Some(count) => {
                    output_cursor.total_n_channels = Some(count);
                    count
                }
                None => {
                    // Budget exhausted before getting count
                    return Ok(DiscoveryOutput {
                        channels: HashMap::new(),
                        channels_done: false,
                        cursor: output_cursor,
                    });
                }
            }
        }
    };

    // 2. Discover new channels (if there are any to discover)
    let from_channel_index = cursor.last_channel_index.map_or(0, |i| i + 1);
    let channels_done = if from_channel_index >= total_n_channels {
        true
    } else {
        let channel_result = discover_incoming_channels(
            &snapshot,
            recipient,
            &decryption_key,
            from_channel_index,
            total_n_channels,
            &budget,
        )
        .await?;

        // Add newly discovered channels to cursor
        for channel in channel_result.channels {
            output_cursor
                .channels
                .entry(channel.info.channel_key)
                .or_insert(ChannelCursor {
                    sender_addr: channel.info.sender_addr,
                    last_subchannel_index: None,
                    subchannels: HashMap::new(),
                });
        }

        output_cursor.last_channel_index = channel_result
            .last_index
            .or(output_cursor.last_channel_index);
        !channel_result.has_more
    };

    // 3. Process ALL channels in cursor (new + existing)
    // Skip if no channels to process
    if output_cursor.channels.is_empty() {
        return Ok(DiscoveryOutput {
            channels: HashMap::new(),
            channels_done,
            cursor: output_cursor,
        });
    }

    let mut join_set = JoinSet::new();

    for (channel_key, channel_cursor) in output_cursor.channels.iter() {
        join_set.spawn(discover_channel_content(
            snapshot.clone(),
            *channel_key,
            channel_cursor.clone(),
            budget.clone(),
        ));
    }

    // 4. Collect results as they complete
    let mut channels_result: HashMap<Felt, ChannelResult> = HashMap::new();

    while let Some(result) = join_set.join_next().await {
        let discovery = result.map_err(|e| {
            DiscoveryError::Storage(discovery_core::storage::StorageError::Backend(Box::new(e)))
        })??;

        // Update cursor
        output_cursor
            .channels
            .insert(discovery.channel_key, discovery.cursor);

        // Add to results
        channels_result.insert(discovery.channel_key, discovery.result);
    }

    Ok(DiscoveryOutput {
        channels: channels_result,
        channels_done,
        cursor: output_cursor,
    })
}

/// Result of discovering notes for a subchannel.
struct SubchannelDiscovery {
    token: Felt,
    result: SubchannelResult,
    cursor: SubchannelCursor,
}

/// Discovers all subchannels and notes for a single channel.
async fn discover_channel_content<S>(
    snapshot: S,
    channel_key: Felt,
    mut channel_cursor: ChannelCursor,
    budget: IoBudget,
) -> Result<ChannelDiscovery, DiscoveryError>
where
    S: IViews + Clone + Send + Sync + 'static,
{
    // 1. Discover new subchannels
    let from_subchannel_index = channel_cursor.last_subchannel_index.map_or(0, |i| i + 1);
    let subchannel_result =
        discover_subchannels(&snapshot, channel_key, from_subchannel_index, &budget).await?;

    let subchannels_done = !subchannel_result.has_more;

    // 2. Add newly discovered subchannels to cursor
    for subchannel in subchannel_result.subchannels {
        channel_cursor
            .subchannels
            .entry(subchannel.token)
            .or_insert(SubchannelCursor {
                last_note_index: None,
            });
    }

    channel_cursor.last_subchannel_index = subchannel_result
        .last_index
        .or(channel_cursor.last_subchannel_index);

    // 3. Process ALL subchannels in cursor (new + existing)
    let mut note_join_set = JoinSet::new();

    for (token, subchannel_cursor) in channel_cursor.subchannels.iter() {
        note_join_set.spawn(discover_subchannel_notes(
            snapshot.clone(),
            channel_key,
            *token,
            subchannel_cursor.clone(),
            budget.clone(),
        ));
    }

    // 4. Collect note discovery results
    let mut subchannels_result: HashMap<Felt, SubchannelResult> = HashMap::new();

    while let Some(result) = note_join_set.join_next().await {
        let discovery = result.map_err(|e| {
            DiscoveryError::Storage(discovery_core::storage::StorageError::Backend(Box::new(e)))
        })??;

        // Update subchannel cursor
        channel_cursor
            .subchannels
            .insert(discovery.token, discovery.cursor);

        // Add to results
        subchannels_result.insert(discovery.token, discovery.result);
    }

    Ok(ChannelDiscovery {
        channel_key,
        result: ChannelResult {
            sender_addr: channel_cursor.sender_addr,
            subchannels_done,
            subchannels: subchannels_result,
        },
        cursor: channel_cursor,
    })
}

/// Discovers all notes for a single subchannel.
async fn discover_subchannel_notes<S>(
    snapshot: S,
    channel_key: Felt,
    token: Felt,
    subchannel_cursor: SubchannelCursor,
    budget: IoBudget,
) -> Result<SubchannelDiscovery, DiscoveryError>
where
    S: IViews,
{
    let from_note_index = subchannel_cursor.last_note_index.map_or(0, |i| i + 1);

    let notes_discovery =
        discover_notes(&snapshot, channel_key, token, from_note_index, &budget).await?;

    let notes_done = !notes_discovery.has_more;

    let notes: Vec<NoteResult> = notes_discovery
        .notes
        .into_iter()
        .map(|note| NoteResult {
            index: note.index,
            note_id: note.note_id,
            amount: note.amount,
        })
        .collect();

    // Update cursor with last_index from result, or keep existing if none discovered
    let cursor = SubchannelCursor {
        last_note_index: notes_discovery
            .last_index
            .or(subchannel_cursor.last_note_index),
    };

    Ok(SubchannelDiscovery {
        token,
        result: SubchannelResult { notes_done, notes },
        cursor,
    })
}

// Unit tests for discovery logic are covered by:
// 1. discovery-core unit tests (with MockBackend and test_fixtures)
// 2. discovery-service integration tests (with real devnet)
