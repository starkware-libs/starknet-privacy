//! Incoming sync endpoint for discovering channels, subchannels, and notes.
//!
//! Provides the `/v1/discovery/incoming/sync` endpoint.

mod handler;
mod types;
pub(crate) mod validation;

pub use handler::incoming_sync_handler;
pub use types::{IncomingSyncRequest, IncomingSyncResponse, DEFAULT_MAX_READS, MAX_READS_CAP};
