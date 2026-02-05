//! Discovery functionality for finding and decrypting channels.

use thiserror::Error;

use crate::privacy_pool::decryption::DecryptionError;
use crate::storage_backend::StorageError;

pub mod cursor;
pub mod incoming_channels;
pub mod last_note_index;
pub mod notes;
pub mod outgoing_channels;
pub mod subchannels;

/// Cost for `get_num_of_channels` (1 storage slot read).
pub const COST_NUM_CHANNELS: usize = 1;

/// Cost for `get_channel_info` (3 storage slot reads).
pub const COST_CHANNEL_INFO: usize = 3;

/// Cost for `get_subchannel_info` (2 storage slot reads).
pub const COST_SUBCHANNEL_INFO: usize = 2;

/// Cost for `get_note` + `nullifier_exists` (2 storage slot reads).
pub const COST_NOTE: usize = 2;

/// Cost for `get_outgoing_channel_info` (2 storage slot reads: salt + enc_recipient_addr).
pub const COST_OUTGOING_CHANNEL_INFO: usize = 2;

/// Cost for a single note existence probe (1 `get_note` read, no nullifier check).
pub const COST_NOTE_PROBING: usize = 1;

/// Errors that can occur during channel discovery.
#[derive(Debug, Error)]
pub enum DiscoveryError {
    /// Storage access error.
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    /// Decryption error.
    #[error("decryption error at index {index}: {source}")]
    Decryption {
        /// The channel index that failed to decrypt.
        index: u64,
        /// The underlying decryption error.
        #[source]
        source: DecryptionError,
    },
    /// A spawned task panicked.
    #[error("spawned task panicked: {0}")]
    TaskPanicked(String),
    /// Invalid cursor data provided by client.
    #[error("invalid cursor: {0}")]
    InvalidCursor(String),
}
