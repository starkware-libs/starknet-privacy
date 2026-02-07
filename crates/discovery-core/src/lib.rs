pub mod discovery;
pub mod io_budget;
pub mod privacy_pool;
pub mod storage_backend;
pub mod sync;

pub use discovery::{
    incoming_channels, notes, outgoing_channels, preflight, subchannels, ChannelCursor,
    DiscoveryCursor, DiscoveryError, SubchannelCursor,
};

#[cfg(test)]
mod test_fixtures;
