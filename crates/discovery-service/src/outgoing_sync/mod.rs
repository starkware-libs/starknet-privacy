//! Outgoing sync endpoint for discovering outgoing channels and note indices.
//!
//! Provides the `POST /v1/sync/outgoing_state` endpoint.

mod handler;
mod types;

pub use handler::outgoing_sync_handler;
pub use types::{OutgoingSyncRequest, OutgoingSyncResponse};
