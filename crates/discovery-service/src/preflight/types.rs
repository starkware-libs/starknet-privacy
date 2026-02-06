//! Request/response types for the preflight endpoint.

use serde::{Deserialize, Serialize};
use starknet_core::types::Felt;

/// Request body for POST /v1/discovery/preflight.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightRequest {
    /// The sender's address.
    pub sender_address: Felt,
    /// The sender's private viewing key.
    pub viewing_key: Felt,
    /// The recipient's address.
    pub recipient: Felt,
    /// The token contract address.
    pub token: Felt,
}

/// Response body for POST /v1/discovery/preflight.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightResponse {
    /// Block hash pinning the reads in this response.
    pub block_ref: Felt,
    /// Whether the sender has a public key registered on-chain.
    pub sender_registered: bool,
    /// Whether the channel from sender to recipient exists.
    pub channel_exists: bool,
    /// Whether the token subchannel exists within the channel.
    pub subchannel_exists: bool,
}
