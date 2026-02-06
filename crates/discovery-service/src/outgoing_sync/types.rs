//! Request/response types for the outgoing sync endpoint.

use std::collections::HashMap;

use discovery_core::discovery::cursor::DiscoveryCursor;
use discovery_core::sync::outgoing_state::OutgoingChannelOutput;
use serde::{Deserialize, Serialize};
use starknet_core::types::Felt;

/// Request body for POST /v1/sync/outgoing_state.
///
/// # Sync Flow
///
/// **First request** (fresh sync):
/// ```json
/// {
///   "sender_address": "0x...",
///   "viewing_key": "0x...",
///   "last_known_block": "0x..."  // Optional: for reorg detection
/// }
/// ```
///
/// **Subsequent requests** (pagination within same session):
/// ```json
/// {
///   "sender_address": "0x...",
///   "viewing_key": "0x...",
///   "block_ref": "0x...",  // From previous response
///   "cursor": { ... }      // From previous response
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingSyncRequest {
    /// The sender's address.
    pub sender_address: Felt,
    /// The sender's private viewing key.
    pub viewing_key: Felt,
    /// Block hash for reorg detection. Set on first request of a new sync
    /// session to the `block_hash` from your last completed sync.
    /// Server returns 409 if this block was reorged out.
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

/// Response body for POST /v1/sync/outgoing_state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingSyncResponse {
    /// Block hash pinning all reads in this response. Pass back as
    /// `block_ref` in subsequent requests for consistency.
    pub block_ref: Felt,
    /// Discovered outgoing channel results, keyed by recipient address.
    pub channels: HashMap<Felt, OutgoingChannelOutput>,
    /// Updated cursor for continuation. Pass back as `cursor` in next request.
    pub cursor: DiscoveryCursor,
}
