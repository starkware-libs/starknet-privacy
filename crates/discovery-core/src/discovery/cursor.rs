//! Cursor types for paginated discovery.
//!
//! These cursors track progress across paginated discovery calls, allowing
//! callers to resume discovery from where they left off.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

/// Top-level cursor for channel discovery (shared by incoming and outgoing).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscoveryCursor {
    /// Skip channel discovery. When `true`, only processes channels already
    /// in the cursor — use this after channel discovery is complete.
    /// Defaults to `false` (discover new channels).
    #[serde(default)]
    pub skip_channel_discovery: bool,

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

/// Cursor state for a single channel (shared by incoming and outgoing).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelCursor {
    /// Channel key (set for incoming, None for outgoing where it's derivable).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_key: Option<Felt>,

    /// Skip subchannel discovery. When `true`, only processes subchannels
    /// already in the cursor. Defaults to `false` (discover new subchannels).
    #[serde(default)]
    pub skip_subchannel_discovery: bool,

    /// Last fully processed subchannel index. `None` = start from index 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_subchannel_index: Option<u64>,

    /// Subchannels with pending note discovery, keyed by token address.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub subchannels: HashMap<Felt, SubchannelCursor>,
}

/// Cursor state for a single subchannel (shared by incoming and outgoing).
///
/// For incoming (linear scan): only `last_note_index` is used.
/// For outgoing (exponential search): `last_note_index` = lo, `max_note_index` = hi.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubchannelCursor {
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
