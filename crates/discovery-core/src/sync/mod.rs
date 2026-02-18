//! High-level sync orchestration.
//!
//! Composes discovery primitives into complete sync workflows.
//! Shared helpers ([`process_pending_channels`] and
//! [`discover_and_process_subchannels`]) factor out the concurrent
//! extract → process → re-insert pattern used by both incoming and outgoing
//! orchestrators.

use std::future::Future;

use futures::stream::{FuturesUnordered, StreamExt};
use starknet_types_core::felt::Felt;

use crate::discovery::subchannels::discover_subchannels_paginated;
use crate::discovery::{ChannelCursor, DiscoveryCursor, DiscoveryError, SubchannelCursor};
use crate::io_budget::IoBudget;
use crate::privacy_pool::views::IViews;

pub mod incoming_state;
pub mod outgoing_state;

/// Extracts incomplete channels from the cursor, processes them concurrently
/// via [`FuturesUnordered`], and re-inserts the updated channel cursors.
///
/// Returns a vec of `(address, result)` pairs for the caller to post-process.
/// Complete channels remain untouched in the cursor.
pub(crate) async fn process_pending_channels<T, F, Fut>(
    cursor: &mut DiscoveryCursor,
    process_fn: F,
) -> Result<Vec<(Felt, T)>, DiscoveryError>
where
    F: Fn(Felt, ChannelCursor) -> Fut,
    Fut: Future<Output = Result<(T, ChannelCursor), DiscoveryError>>,
{
    let mut pending: FuturesUnordered<_> = cursor
        .channels
        .extract_if(|_, ch| !ch.is_complete())
        .map(|(addr, ch_cursor)| {
            let fut = process_fn(addr, ch_cursor);
            async move {
                let (result, new_cursor) = fut.await?;
                Ok::<_, DiscoveryError>((addr, result, new_cursor))
            }
        })
        .collect();

    let mut results = Vec::new();
    while let Some(res) = pending.next().await {
        let (addr, item, new_cursor) = res?;
        results.push((addr, item));
        cursor.channels.insert(addr, new_cursor);
    }

    Ok(results)
}

/// Discovers subchannels within a channel, then processes each incomplete
/// subchannel concurrently via [`FuturesUnordered`].
///
/// Handles:
/// 1. Extracting `channel_key` from the cursor (fails if missing).
/// 2. Running [`discover_subchannels_paginated`] for new subchannels.
/// 3. Extracting incomplete subchannels and processing them concurrently.
/// 4. Re-inserting updated subchannel cursors.
///
/// Returns `(results, updated_channel_cursor)` where `results` is a vec of
/// `(token, T)` pairs produced by the `process_subchannel` function.
pub(crate) async fn discover_and_process_subchannels<S, T, F, Fut>(
    pool: &S,
    mut cursor: ChannelCursor,
    max_cursor_subchannels: usize,
    budget: &IoBudget,
    process_subchannel: F,
) -> Result<(Vec<(Felt, T)>, ChannelCursor), DiscoveryError>
where
    S: IViews,
    F: Fn(Felt, Felt, SubchannelCursor) -> Fut,
    Fut: Future<Output = Result<(T, SubchannelCursor), DiscoveryError>>,
{
    let channel_key = cursor.channel_key.ok_or_else(|| {
        DiscoveryError::InvalidCursor("channel_key is required".into())
    })?;

    discover_subchannels_paginated(pool, channel_key, &mut cursor, max_cursor_subchannels, budget)
        .await?;

    let mut pending: FuturesUnordered<_> = cursor
        .subchannels
        .extract_if(|_, sc| !sc.note_discovery_complete)
        .map(|(token, sc_cursor)| {
            let fut = process_subchannel(channel_key, token, sc_cursor);
            async move {
                let (result, new_cursor) = fut.await?;
                Ok::<_, DiscoveryError>((token, result, new_cursor))
            }
        })
        .collect();

    let mut results = Vec::new();
    while let Some(res) = pending.next().await {
        let (token, item, new_cursor) = res?;
        results.push((token, item));
        cursor.subchannels.insert(token, new_cursor);
    }

    Ok((results, cursor))
}
