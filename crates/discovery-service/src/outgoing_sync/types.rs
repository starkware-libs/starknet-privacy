//! Request/response types for the outgoing sync endpoint.

use std::collections::HashSet;

use discovery_core::outgoing_channels::OutgoingChannel;
use discovery_core::sync::outgoing_state::OutgoingSubchannel;
use discovery_core::DiscoveryCursor;
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
///   "decryption_key": "0x...",
///   "last_known_block": "0x..."  // Optional: for reorg detection
/// }
/// ```
///
/// **Subsequent requests** (pagination within same session):
/// ```json
/// {
///   "sender_address": "0x...",
///   "decryption_key": "0x...",
///   "block_ref": "0x...",  // From previous response
///   "cursor": { ... }      // From previous response
/// }
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingSyncRequest {
    /// The sender's address.
    pub sender_address: Felt,
    /// The sender's private viewing key.
    pub decryption_key: Felt,
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
    /// Optional filter: only return channels for these recipients.
    /// Recipients without an existing on-chain channel are returned
    /// with `precomputed: true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipients: Option<HashSet<Felt>>,
}

/// Response body for POST /v1/sync/outgoing_state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutgoingSyncResponse {
    /// Block hash pinning all reads in this response. Pass back as
    /// `block_ref` in subsequent requests for consistency.
    pub block_ref: Felt,
    /// Discovered outgoing channels (one per recipient). Includes both
    /// on-chain channels (`precomputed: false`) and precomputed channels
    /// for requested recipients (`precomputed: true`).
    pub channels: Vec<OutgoingChannel>,
    /// Discovered outgoing subchannels (one per recipient×token pair).
    pub subchannels: Vec<OutgoingSubchannel>,
    /// Updated cursor for continuation. Pass back as `cursor` in next request.
    pub cursor: DiscoveryCursor,
}
