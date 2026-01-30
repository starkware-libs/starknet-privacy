#![allow(unused)]

use std::path::Path;

mod devnet;
mod indexer;
mod process;

pub use devnet::{DevnetClient, DevnetConfig, DumpMetadata};
pub use indexer::{IndexerClient, IndexerSpawnConfig};

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

/// Spawn an indexer connected to `devnet`, wait until it is ready (API up + first block processed).
pub async fn setup_indexer(
    devnet: &DevnetClient,
    metadata: Option<&DumpMetadata>,
) -> IndexerClient {
    let mut indexer = IndexerClient::spawn(
        env!("CARGO_BIN_EXE_discovery-service"),
        IndexerSpawnConfig {
            ws_url: devnet.ws_url(),
            contract_address: metadata.map(|m| m.contract_address),
            rpc_url: metadata.map(|_| devnet.rpc_url()),
            ..Default::default()
        },
    )
    .await
    .expect("Failed to spawn indexer");
    indexer
        .wait_until_ready(devnet)
        .await
        .expect("Indexer not ready");
    indexer
}
