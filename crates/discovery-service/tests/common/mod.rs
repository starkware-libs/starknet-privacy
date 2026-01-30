#![allow(unused)]

use std::path::Path;

mod devnet;
mod indexer;
mod process;

pub use devnet::{DevnetClient, DevnetConfig, DumpMetadata};
pub use indexer::{IndexerClient, IndexerSpawnConfig};
pub use process::find_free_port;

pub const FIXTURES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

/// Spawn devnet and load dump fixtures.
/// Returns devnet client and metadata with contract/alice addresses.
pub async fn setup_devnet_with_dump() -> (DevnetClient, DumpMetadata) {
    let mut devnet = DevnetClient::spawn(DevnetConfig {
        seed: 42,
        accounts: 3,
        ..Default::default()
    })
    .expect("failed to spawn devnet");
    let metadata = devnet
        .load_dump(Path::new(FIXTURES_DIR))
        .await
        .expect("failed to load dump");
    (devnet, metadata)
}
