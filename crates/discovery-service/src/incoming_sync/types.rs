//! Request/response types for the incoming sync endpoint.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use starknet_core::types::Felt;

use crate::chain_state::ChainHead;

/// Default max_reads if not specified.
pub const DEFAULT_MAX_READS: u32 = 1000;

/// Server-enforced maximum for max_reads.
pub const MAX_READS_CAP: u32 = 5000;

/// Request body for POST /v1/discovery/incoming/sync.
///
/// # Sync Flow
///
/// **First request** (fresh sync or new session):
/// ```json
/// {
///   "recipient_address": "0x...",
///   "decryption_key": "0x...",
///   "cursor": { "last_known_block": "0x..." }  // Optional: for reorg detection
/// }
/// ```
///
/// **Subsequent requests** (pagination within same session):
/// ```json
/// {
///   "recipient_address": "0x...",
///   "decryption_key": "0x...",
///   "cursor": { ... }  // Use cursor from previous response as-is
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingSyncRequest {
    /// The recipient's address.
    pub recipient_address: Felt,
    /// The recipient's private viewing key.
    pub decryption_key: Felt,
    /// Cursor for pagination and block consistency.
    #[serde(default)]
    pub cursor: IncomingSyncCursor,
    /// Maximum number of storage reads to perform.
    #[serde(default)]
    pub max_reads: Option<u32>,
}

/// Cursor for tracking sync state: block reference and discovery progress.
///
/// # Block Fields
///
/// The cursor contains two block-related fields that serve different purposes:
///
/// ## `last_known_block` - Reorg Detection
///
/// Set this to the `block_hash` from your last **completed** sync session.
/// The server checks if this block is still in the canonical chain:
/// - If canonical: sync proceeds normally
/// - If not canonical (reorged): returns `409 BLOCK_REORGED` error
///
/// **When to set:**
/// - On the **first request** of a new sync session, if you have prior sync data
/// - NOT on pagination requests within the same session
///
/// **When to leave empty:**
/// - Fresh sync with no prior data
/// - Pagination requests (already validated on first request)
///
/// ## `block_ref` - Query Consistency
///
/// Pins all storage queries to a specific block. This ensures consistent
/// reads across paginated requests (state doesn't change mid-sync).
///
/// **When to set:**
/// - On **pagination requests** - use the value from the previous response's cursor
/// - The server sets this automatically in the response cursor
///
/// **When to leave empty:**
/// - On the **first request** - server uses current head and returns it
///
/// # Control Fields
///
/// ## `total_n_channels` - Known Channel Count
///
/// When set, indicates the total number of channels known from a previous response.
/// This serves two purposes:
/// 1. Skip the `get_num_of_channels` RPC call (optimization)
/// 2. When `last_channel_index >= total_n_channels - 1`, skip channel discovery entirely
///
/// Leave empty on the first request. On subsequent requests, use the value from
/// the response cursor.
///
/// ## `channels` Map Keys - Subchannel Discovery Toggle
///
/// Presence of a key in the `channels` map controls whether to process that channel:
/// - Key present: discover subchannels/notes for that channel
/// - Key absent: skip that channel entirely
///
/// Remove a key when `subchannels_done = true` for that channel.
///
/// ## `subchannels` Map Keys - Note Discovery Toggle
///
/// Presence of a key in `channel_cursor.subchannels` controls note discovery:
/// - Key present: discover notes for that subchannel
/// - Key absent: skip that subchannel entirely
///
/// Remove a key when `notes_done = true` for that subchannel.
///
/// # Typical Flow
///
/// 1. **First request**: `{ last_known_block: "0xprev..." }` (or empty if fresh)
///    - Server validates `last_known_block`, queries at current head
///    - Response includes `head` and cursor with `block_ref` set
///
/// 2. **Pagination requests**: Use response cursor as-is
///    - Cursor has `block_ref` set, `last_known_block` cleared
///    - Server queries at `block_ref`, no reorg check needed
///
/// 3. **Next session**: Store final `head.block_hash` as your `last_known_block`
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IncomingSyncCursor {
    /// Block hash for reorg detection. Set on first request of a new sync
    /// session to the `block_hash` from your last completed sync.
    /// Server returns 409 if this block was reorged out.
    /// Leave empty on pagination requests or fresh syncs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_known_block: Option<Felt>,

    /// Block hash to query state at. Ensures consistent reads across
    /// paginated requests. Leave empty on first request (server uses
    /// current head). On pagination, use the cursor from previous response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_ref: Option<Felt>,

    /// Total number of channels (cached from previous discovery).
    /// When set, skips the `get_num_of_channels` RPC call.
    /// When `last_channel_index >= total_n_channels - 1`, channel discovery is skipped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_n_channels: Option<u64>,

    /// Last fully processed channel index. `None` = start from index 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_channel_index: Option<u64>,

    /// Channels to process for subchannel/note discovery. Keyed by channel_key.
    /// Remove a key when `subchannels_done = true` for that channel.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub channels: HashMap<Felt, ChannelCursor>,
}

/// Cursor state for a single channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelCursor {
    /// Sender address (cached to avoid re-discovery).
    pub sender_addr: Felt,

    /// Last fully processed subchannel index. `None` = start from index 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_subchannel_index: Option<u64>,

    /// Subchannels to process for note discovery. Keyed by token address.
    /// Remove a key when `notes_done = true` for that subchannel.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub subchannels: HashMap<Felt, SubchannelCursor>,
}

/// Cursor state for a single subchannel.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SubchannelCursor {
    /// Last fully processed note index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_note_index: Option<u64>,
}

/// Response body for POST /v1/discovery/incoming/sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingSyncResponse {
    /// Current chain head. Only present on first sync (when block_ref not specified).
    /// Use `head.block_hash` as `block_ref` for subsequent requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<ChainHead>,
    /// True if all channels have been discovered.
    pub channels_done: bool,
    /// Discovered channel results, keyed by channel_key.
    pub channels: HashMap<Felt, ChannelResult>,
    /// Updated cursor for continuation.
    pub cursor: IncomingSyncCursor,
}

/// Result data for a single channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelResult {
    /// Sender address for this channel.
    pub sender_addr: Felt,
    /// True if all subchannels in this channel have been discovered.
    pub subchannels_done: bool,
    /// Discovered subchannels, keyed by token address.
    pub subchannels: HashMap<Felt, SubchannelResult>,
}

/// Result data for a single subchannel (token channel).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubchannelResult {
    /// True if all notes in this subchannel have been discovered.
    pub notes_done: bool,
    /// Discovered notes.
    pub notes: Vec<NoteResult>,
}

/// Result data for a single note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteResult {
    /// Note index within the subchannel.
    pub index: u64,
    /// Note ID (storage key).
    pub note_id: Felt,
    /// Decrypted amount.
    pub amount: u128,
}
