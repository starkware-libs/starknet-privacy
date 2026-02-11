//! Cursor types for paginated discovery.
//!
//! These cursors track progress across paginated discovery calls, allowing
//! callers to resume discovery from where they left off.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

/// Capacity limits for cursor growth during paginated discovery.
///
/// These caps prevent unbounded cursor expansion when processing accounts
/// with many channels or subchannels. Discovery stops adding new entries
/// once the cursor reaches the limit; existing entries are still processed.
#[derive(Debug, Clone, Copy)]
pub struct CursorLimits {
    /// Maximum number of channels in the cursor at once.
    pub max_channels: usize,
    /// Maximum number of subchannels per channel in the cursor at once.
    pub max_subchannels: usize,
}

/// Top-level cursor for channel discovery (shared by incoming and outgoing).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscoveryCursor {
    /// All channels have been enumerated. Set by the discovery service once
    /// the sentinel channel is reached. When `true`, no further channel
    /// discovery is attempted — only channels already in the cursor are
    /// processed.
    #[serde(default)]
    pub channel_discovery_complete: bool,

    /// Total number of channels (cached from `get_num_of_channels` for incoming).
    /// Used as optimization to avoid redundant RPC calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_n_channels: Option<u64>,

    /// Last fully processed channel index. `None` = start from index 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_channel_index: Option<u64>,

    /// Channels with pending subchannel/note discovery.
    /// - Incoming: keyed by sender address.
    /// - Outgoing: keyed by recipient address.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub channels: HashMap<Felt, ChannelCursor>,
}

impl DiscoveryCursor {
    /// Returns `true` when all discovery levels are complete: channels,
    /// subchannels within each channel, and notes within each subchannel.
    pub fn is_complete(&self) -> bool {
        self.channel_discovery_complete && self.all_channels_processed()
    }

    /// Returns `true` when every channel currently in the cursor has
    /// completed subchannel and note discovery. Also returns `true` when
    /// the cursor has no channels (vacuously).
    ///
    /// Used by sync orchestrators to decide whether to discover new
    /// channels vs. process pending subchannel/note work.
    pub fn all_channels_processed(&self) -> bool {
        self.channels.values().all(ChannelCursor::is_complete)
    }
}

/// Cursor state for a single channel (shared by incoming and outgoing).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelCursor {
    // TODO: Consider encrypting/masking channel_key in the serialized cursor
    // to avoid exposing it in plaintext (sensitive value).
    /// The channel key for this channel.
    pub channel_key: Felt,

    /// All subchannels have been enumerated. Set by the discovery service
    /// once the sentinel subchannel is reached. When `true`, no further
    /// subchannel discovery is attempted — only subchannels already in the
    /// cursor are processed.
    #[serde(default)]
    pub subchannel_discovery_complete: bool,

    /// Last fully processed subchannel index. `None` = start from index 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_subchannel_index: Option<u64>,

    /// Subchannels with pending note discovery, keyed by token address.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub subchannels: HashMap<Felt, SubchannelCursor>,
}

impl ChannelCursor {
    /// Returns `true` when subchannel discovery is complete and all
    /// subchannels have finished note discovery.
    pub fn is_complete(&self) -> bool {
        self.subchannel_discovery_complete
            && self
                .subchannels
                .values()
                .all(|sc| sc.note_discovery_complete)
    }
}

/// Cursor state for a single subchannel (shared by incoming and outgoing).
///
/// For incoming (linear scan): only `last_note_index` is used.
/// For outgoing (exponential search): `last_note_index` = lo, `max_note_index` = hi.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubchannelCursor {
    /// All notes in this subchannel have been discovered. Set when the
    /// note discovery scan completes without budget exhaustion.
    #[serde(default)]
    pub note_discovery_complete: bool,

    /// Last note index where a note exists.
    /// - Incoming: last scanned index.
    /// - Outgoing: lower bound (lo) for exponential search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note_index: Option<u64>,

    /// - Incoming: last index confirmed to exist by exponential probe. Linear
    ///   scan reads notes up to this index. Kept after scan — used to bound the
    ///   next exponential probe range (`max_note_index * 2`). Re-probe triggers
    ///   when `last_note_index == max_note_index`.
    /// - Outgoing: first index confirmed empty (hi); `Some` = bisection phase.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_note_index: Option<u64>,
}

impl SubchannelCursor {
    /// Returns the next note index to scan from.
    ///
    /// If `last_note_index` is `Some(i)`, returns `i + 1` (resume after last
    /// scanned). If `None`, returns 0 (fresh cursor).
    pub fn start_index(&self) -> u64 {
        self.last_note_index.map_or(0, |i| i + 1)
    }
}
