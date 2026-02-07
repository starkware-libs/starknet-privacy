#![doc = include_str!("../README.md")]

use std::path::PathBuf;

use clap::Parser;
use discovery_service::api_server::ApiServer;
use discovery_service::config::ServiceConfig;
use discovery_service::indexer::Indexer;
use discovery_service::rpc_backend::RpcBackend;
use discovery_service::shutdown::Shutdown;
use tokio::task::JoinHandle;
use tracing::{error, info, subscriber::set_global_default};
use tracing_subscriber::filter::EnvFilter;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
#[command(propagate_version = true)]
struct Cli {
    /// Path to TOML config file (optional).
    #[arg(long)]
    config: Option<PathBuf>,
}

fn init_tracing(log_level: Option<&str>) {
    let env_filter = match log_level {
        Some(level) => EnvFilter::new(level),
        None => EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
    };

    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr)
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .finish();

    set_global_default(subscriber).expect("Failed to set tracing subscriber");
}

#[tokio::main]
async fn main() {
    // Load environment variables from a .env file if it exists.
    dotenv::dotenv().ok();

    let cli = Cli::parse();

    // Load config: file (if provided) → env overrides → validate
    let mut config = match &cli.config {
        Some(path) => ServiceConfig::load(path).unwrap_or_else(|e| {
            eprintln!("Failed to load config file: {e}");
            std::process::exit(1);
        }),
        None => ServiceConfig::default(),
    };
    config.apply_env_overrides();
    config.validate().unwrap_or_else(|e| {
        eprintln!("Configuration error: {e}");
        std::process::exit(1);
    });

    // Extract log level before build_configs() consumes the config
    let log_level = config.logging.level.clone();
    init_tracing(log_level.as_deref());

    info!("Discovery service is launching...");

    let shutdown = Shutdown::default();

    // Build component configs from the unified service config
    let (rpc_config, contract_address, indexer_config, api_server_config) =
        config.build_configs().unwrap_or_else(|e| {
            eprintln!("Configuration error: {e}");
            std::process::exit(1);
        });

    let rpc_backend =
        RpcBackend::new(rpc_config, contract_address).expect("Failed to create RPC backend");

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
