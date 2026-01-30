#![doc = include_str!("../README.md")]

use clap::Parser;
use discovery_service::api_server::{ApiServer, ApiServerConfig};
use discovery_service::indexer::{Indexer, IndexerConfig};
use discovery_service::rpc_backend::{RpcBackend, RpcConfig};
use discovery_service::shutdown::Shutdown;
use tokio::task::JoinHandle;
use tracing::{error, info, subscriber::set_global_default};
use tracing_subscriber::filter::EnvFilter;
use url::Url;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
#[command(propagate_version = true)]
struct Cli {
    /// Logging level (off, error, warn, info, debug, trace). Overrides RUST_LOG.
    #[arg(long)]
    log_level: Option<String>,

    /// API server host and port (e.g., "127.0.0.1:8080"). Overrides API_HOST env var.
    #[arg(long)]
    api_host: Option<String>,
}

fn init_tracing(log_level: Option<&str>) {
    let env_filter = match log_level {
        Some(level) => EnvFilter::new(level),
        None => EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
    };

    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr)
        .finish();

    set_global_default(subscriber).expect("Failed to set tracing subscriber");
}

#[tokio::main]
async fn main() {
    // Load environment variables from a .env file if it exists.
    dotenv::dotenv().ok();

    let cli = Cli::parse();
    init_tracing(cli.log_level.as_deref());

    info!("Discovery service is launching...");

    let shutdown = Shutdown::default();

    let mut indexer_config = IndexerConfig::default();
    if let Ok(ws_url) = std::env::var("WS_URL") {
        indexer_config.ws_url = ws_url;
    }

    let mut rpc_config = RpcConfig::default();
    if let Ok(rpc_url) = std::env::var("RPC_URL") {
        rpc_config.rpc_url = Url::parse(&rpc_url).expect("Failed to parse RPC_URL");
    }
    if let Ok(contract_address) = std::env::var("CONTRACT_ADDRESS") {
        rpc_config.contract_address = contract_address
            .parse()
            .expect("Failed to parse CONTRACT_ADDRESS");
    }
    let rpc_backend = RpcBackend::new(rpc_config).expect("Failed to create RPC backend");

    let mut api_server_config = ApiServerConfig::default();
    if let Some(api_host) = cli.api_host.or_else(|| std::env::var("API_HOST").ok()) {
        api_server_config.api_host = api_host;
    }

    let mut indexer = Indexer::new(indexer_config, shutdown.subscribe(), rpc_backend.clone());
    let mut api_server = ApiServer::new(api_server_config, shutdown.subscribe(), rpc_backend);

    let indexer_handle = tokio::spawn(async move { indexer.run().await });
    let api_server_handle = tokio::spawn(async move { api_server.run().await });

    let shutdown_handle = tokio::spawn(async move { shutdown.run().await });

    match tokio::try_join!(
        flatten(indexer_handle),
        flatten(api_server_handle),
        flatten(shutdown_handle)
    ) {
        Ok(_) => {
            info!("Discovery service has shut down");
            std::process::exit(0);
        }
        Err(_) => {
            error!("Discovery service exited with error");
            std::process::exit(1);
        }
    }
}

async fn flatten<T, E>(handle: JoinHandle<Result<T, E>>) -> Result<T, ()> {
    match handle.await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(_)) => Err(()),
        Err(_) => Err(()),
    }
}
