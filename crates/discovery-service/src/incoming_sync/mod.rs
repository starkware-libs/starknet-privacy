//! Incoming sync endpoint for discovering channels, subchannels, and notes.
//!
//! Provides the `POST /v1/sync/incoming_state` endpoint.

mod handler;
mod types;
pub(crate) mod validation;

pub use handler::incoming_sync_handler;
pub use types::{IncomingSyncRequest, IncomingSyncResponse};
