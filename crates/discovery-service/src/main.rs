//! Minimal Starknet node that syncs state and exposes JSON-RPC API.

mod stub_class_manager;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use apollo_class_manager_types::SharedClassManagerClient;
use apollo_infra::component_definitions::ComponentStarter;
use apollo_reverts::RevertConfig;
use apollo_rpc::RpcConfig;
use apollo_state_sync::create_state_sync_and_runner;
use apollo_state_sync_config::config::{CentralSyncClientConfig, StateSyncConfig};
use apollo_central_sync_config::config::CentralSourceConfig;
use apollo_storage::{StorageConfig, db::DbConfig, storage_reader_server::ServerConfig};
use clap::Parser;
use url::Url;
use starknet_api::core::ChainId;
use tracing::info;

use crate::stub_class_manager::StubClassManagerClient;

/// CLI arguments for the sync node.
///
/// All arguments have sensible defaults, so you can run the binary with no args:
/// ```bash
/// apollo_sync_node
/// ```
#[derive(Parser, Debug)]
#[command(name = "apollo_sync_node")]
#[command(about = "Minimal Starknet node that syncs state via P2P")]
pub struct CliArgs {
    /// Storage data directory.
    #[arg(long, default_value = "./starknet_data")]
    pub data_dir: PathBuf,

    /// Chain ID: SN_MAIN (mainnet), SN_SEPOLIA, or custom.
    #[arg(long, default_value = "SN_MAIN")]
    pub chain_id: String,

    /// Central sync URL.
    #[arg(long, default_value = "https://feeder.alpha-mainnet.starknet.io/")]
    pub central_sync_url: Url,

    /// JSON-RPC server bind address.
    #[arg(long, default_value = "127.0.0.1:8545")]
    pub rpc_addr: String,

    /// Log level (trace, debug, info, warn, error).
    #[arg(long, default_value = "info")]
    pub log_level: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Parse CLI arguments
    let args = CliArgs::parse();

    // Initialize logging
    init_logging(&args.log_level);

    // Build the state sync config
    info!("Starting Apollo Sync Node");
    let state_sync_config = build_state_sync_config(&args);

    // Create Class Manager Client (stub for MVP - works for headers + state_diffs)
    let class_manager_client: SharedClassManagerClient = Arc::new(StubClassManagerClient);

    // Create state sync and runner using the existing helper function
    info!("Creating state sync components...");
    let (_state_sync, mut state_sync_runner) =
        // TODO: hook the block channel to filter state diffs + implement reorg handling
        create_state_sync_and_runner(state_sync_config, class_manager_client);

    // Simply start the runner - it handles everything internally
    info!("Starting sync...");
    state_sync_runner.start().await;

    Ok(())
}

fn init_logging(level: &str) {
    use tracing_subscriber::EnvFilter;

    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(false)
        .with_file(true)
        .with_line_number(true)
        .init();
}

fn build_state_sync_config(args: &CliArgs) -> StateSyncConfig {
    let chain_id = parse_chain_id(&args.chain_id);
    let storage_config = StorageConfig {
        db_config: DbConfig {
            path_prefix: args.data_dir.clone(),
            chain_id: chain_id.clone(),
            enforce_file_exists: false,
            min_size: 1 << 20,    // 1MB
            max_size: 1 << 40,    // 1TB
            growth_step: 1 << 26, // 64MB
            ..Default::default()
        },
        ..Default::default()
    };

    let rpc_addr: SocketAddr = args.rpc_addr.parse().expect("Invalid RPC address");
    let rpc_config = RpcConfig {
        chain_id,
        ip: rpc_addr.ip(),
        port: rpc_addr.port(),
        ..Default::default()
    };

    let central_sync_client_config = CentralSyncClientConfig {
        central_source_config: CentralSourceConfig {
            starknet_url: args.central_sync_url.clone(),
            ..Default::default()
        },
        ..Default::default()
    };

    StateSyncConfig {
        storage_config,
        p2p_sync_client_config: None,
        central_sync_client_config: Some(central_sync_client_config),
        network_config: None,
        revert_config: RevertConfig::default(),
        rpc_config,
        storage_reader_server_config: ServerConfig::default(),
    }
}

fn parse_chain_id(chain_id: &str) -> ChainId {                                                                                                            
    match chain_id.to_uppercase().as_str() {                                                                                                              
        "SN_MAIN" | "MAINNET" => ChainId::Mainnet,                                                                                                        
        "SN_SEPOLIA" | "SEPOLIA" => ChainId::Sepolia,                                                                                                     
        other => ChainId::Other(other.to_string()),                                                                                                       
    }
}
