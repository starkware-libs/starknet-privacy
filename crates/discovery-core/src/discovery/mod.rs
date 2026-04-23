//! Discovery functionality for finding and decrypting channels.

use thiserror::Error;

use crate::io_budget::InsufficientBudgetError;
use crate::privacy_pool::decryption::DecryptionError;
use crate::storage_backend::StorageError;

pub mod cursor;
pub use cursor::{ChannelCursor, CursorLimits, DiscoveryCursor, SubchannelCursor};
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

/// Cost for outgoing channel info (3 storage slot reads: salt + enc_recipient_addr + public_key).
pub const COST_OUTGOING_CHANNEL_INFO: usize = 3;

/// Cost for a single note existence probe (1 `get_note` read, no nullifier check).
pub const COST_NOTE_PROBING: usize = 1;

/// Cost for a single `get_public_key` (1 storage slot read).
pub const COST_PUBLIC_KEY: usize = 1;

/// Cost per `get_block_events` call (events in a single block).
///
/// Cheaper than a range scan because the server walks only one block and the
/// filtered event set is small in the common case.
pub const COST_BLOCK_EVENTS_QUERY: usize = 2;

/// Cost per block sub-range event scan (up to
/// [`RawEventAccess::event_page_size`] blocks).
///
/// Range scans are more expensive than block-level queries because the server
/// walks every block in the range. Orchestrators size sub-ranges by
/// `event_page_size` so, under the sparse-per-user assumption, each call
/// resolves in one underlying RPC page; dense cases paginate internally and
/// we undercount — acceptable for the history path.
///
/// [`RawEventAccess::event_page_size`]: crate::events_backend::RawEventAccess::event_page_size
pub const COST_EVENTS_CHUNK: usize = 10;

/// Minimum server budget to make progress through one step at each discovery level:
/// fetch channel count, discover one channel, discover one subchannel (×2 for sentinel),
/// probe note boundary, and scan 10 notes.
pub fn min_server_budget(max_note_log_index: u32) -> usize {
    COST_NUM_CHANNELS
        + COST_CHANNEL_INFO
        + 2 * COST_SUBCHANNEL_INFO
        + last_note_index::boundary_budget(max_note_log_index)
        + 10 * COST_NOTE
}

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
    /// The I/O budget is too small to make progress.
    #[error("insufficient budget: needed {needed}, available {available}")]
    InsufficientBudget { needed: usize, available: usize },
    /// A computed cost exceeds `usize` (only reachable on 32-bit targets).
    #[error("cost overflow: {0} exceeds usize")]
    CostOverflow(u64),
    /// Expected event not found on-chain.
    #[error("missing event: {0}")]
    EventError(String),
}

impl From<InsufficientBudgetError> for DiscoveryError {
    fn from(error: InsufficientBudgetError) -> Self {
        Self::InsufficientBudget {
            needed: error.needed,
            available: error.available,
        }
    }
}
