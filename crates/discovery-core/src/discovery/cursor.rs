//! Cursor types for paginated discovery.
//!
//! These cursors track progress across paginated discovery calls, allowing
//! callers to resume discovery from where they left off.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use starknet_types_core::felt::Felt;

/// Top-level cursor tracking discovery progress across all channels.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscoveryCursor {
    /// Total number of channels (cached from `get_num_of_channels`).
    /// When set, skips the channel count RPC call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_n_channels: Option<u64>,

    /// Last fully processed channel index. `None` = start from index 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_channel_index: Option<u64>,

    /// Channels with pending subchannel/note discovery, keyed by channel_key.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub channels: HashMap<Felt, ChannelCursor>,
}

/// Cursor state for a single channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelCursor {
    /// Sender address (cached from channel discovery).
    pub sender_addr: Felt,

    /// Total number of subchannels (cached when sentinel is found).
    /// When set, subchannel discovery is skipped entirely — zero budget cost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_n_subchannels: Option<u64>,

    /// Last fully processed subchannel index. `None` = start from index 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_subchannel_index: Option<u64>,

    /// Subchannels with pending note discovery, keyed by token address.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub subchannels: HashMap<Felt, SubchannelCursor>,
}

/// Cursor state for a single subchannel.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubchannelCursor {
    /// Last fully processed note index. `None` = start from index 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note_index: Option<u64>,
}
