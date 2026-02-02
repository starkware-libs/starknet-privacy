//! Discovery functionality for finding and decrypting channels.

use thiserror::Error;

use crate::decryption::DecryptionError;
use crate::storage::StorageError;

pub mod incoming_channels;
pub mod subchannels;

pub use incoming_channels::{discover_incoming_channels, DiscoveryResult, IncomingChannel};
pub use subchannels::{discover_subchannels, Subchannel, SubchannelDiscoveryResult};

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
}
