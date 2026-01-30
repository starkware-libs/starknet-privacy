//! Request/response types for the incoming sync endpoint.

use std::collections::HashMap;

use discovery_core::discovery::cursor::DiscoveryCursor;
use discovery_core::sync::incoming_state::ChannelOutput;
use serde::{Deserialize, Serialize};
use starknet_core::types::Felt;

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
///   "last_known_block": "0x..."  // Optional: for reorg detection
/// }
/// ```
///
/// **Subsequent requests** (pagination within same session):
/// ```json
/// {
///   "recipient_address": "0x...",
///   "decryption_key": "0x...",
///   "block_ref": "0x...",  // From previous response
///   "cursor": { ... }      // From previous response
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingSyncRequest {
    /// The recipient's address.
    pub recipient_address: Felt,
    /// The recipient's private viewing key.
    pub decryption_key: Felt,
    /// Block hash for reorg detection. Set on first request of a new sync
    /// session to the `block_hash` from your last completed sync.
    /// Server returns 409 if this block was reorged out.
    /// Leave empty on pagination requests or fresh syncs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_known_block: Option<Felt>,
    /// Block hash to query state at. Ensures consistent reads across
    /// paginated requests. Leave empty on first request (server uses
    /// current head). On pagination, use the value from previous response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_ref: Option<Felt>,
    /// Discovery cursor for pagination. Use the cursor from previous
    /// response to continue discovery.
    #[serde(default)]
    pub cursor: DiscoveryCursor,
    /// Maximum number of storage reads to perform.
    #[serde(default)]
    pub max_reads: Option<u32>,
}

/// Response body for POST /v1/discovery/incoming/sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingSyncResponse {
    /// Block hash pinning all reads in this response. Pass back as
    /// `block_ref` in subsequent requests for consistency.
    pub block_ref: Felt,
    /// Discovered channel results, keyed by channel_key.
    pub channels: HashMap<Felt, ChannelOutput>,
    /// Updated cursor for continuation. Pass back as `cursor` in next request.
    pub cursor: DiscoveryCursor,
}
