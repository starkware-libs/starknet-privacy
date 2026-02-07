//! Request/response types for the incoming sync endpoint.

use discovery_core::incoming_channels::IncomingChannel;
use discovery_core::notes::DecryptedNote;
use discovery_core::sync::incoming_state::IncomingSubchannel;
use discovery_core::DiscoveryCursor;
use serde::{Deserialize, Serialize};
use starknet_core::types::Felt;

/// Request body for POST /v1/sync/incoming_state.
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
}

/// Response body for POST /v1/sync/incoming_state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IncomingSyncResponse {
    /// Block hash pinning all reads in this response. Pass back as
    /// `block_ref` in subsequent requests for consistency.
    pub block_ref: Felt,
    /// Discovered incoming channels (one per sender).
    pub channels: Vec<IncomingChannel>,
    /// Discovered incoming subchannels (one per sender×token pair).
    pub subchannels: Vec<IncomingSubchannel>,
    /// Discovered notes with sender and token context.
    pub notes: Vec<DecryptedNote>,
    /// Updated cursor for continuation. Pass back as `cursor` in next request.
    pub cursor: DiscoveryCursor,
}
