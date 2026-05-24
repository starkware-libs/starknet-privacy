#![doc = include_str!("../README.md")]

use std::path::PathBuf;

use clap::Parser;
use std::sync::Arc;

use discovery_service::api::ApiServer;
use discovery_service::config::{LogFormat, ServiceConfig};
use discovery_service::indexer::Indexer;
use discovery_service::rpc_backend::RpcBackend;
use discovery_service::shutdown::Shutdown;
use tokio::task::JoinHandle;
use tower_ohttp::OhttpGateway;
use tracing::{error, info, subscriber::set_global_default, Subscriber};
use tracing_subscriber::filter::EnvFilter;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
#[command(propagate_version = true)]
struct Cli {
    /// Path to TOML config file (optional).
    #[arg(long)]
    config: Option<PathBuf>,
}

fn init_tracing(log_level: Option<&str>, format: LogFormat) {
    let env_filter = match log_level {
        Some(level) => EnvFilter::new(level),
        None => EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
    };

    let builder = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr);

    let subscriber: Box<dyn Subscriber + Send + Sync> = match format {
        LogFormat::Text => Box::new(
            builder
                .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
                .finish(),
        ),
        LogFormat::Json => Box::new(builder.with_ansi(false).json().finish()),
    };
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
    config.apply_env_overrides().unwrap_or_else(|e| {
        eprintln!("Configuration error: {e}");
        std::process::exit(1);
    });

    // Extract logging settings before build_configs() consumes the config
    let log_level = config.logging.level.clone();
    let log_format = config.logging.format;
    init_tracing(log_level.as_deref(), log_format);

    info!("Discovery service is launching...");

    let shutdown = Shutdown::default();

    // Build component configs from the unified service config
    let (rpc_config, indexer_config, api_server_config, ohttp_config) = config.build_configs();

    // Initialize OHTTP key manager if enabled.
    let ohttp_gateway = if ohttp_config.enabled {
        match OhttpGateway::from_env() {
            Ok(manager) => Some(Arc::new(manager)),
            Err(error) => {
                eprintln!("Failed to initialize OHTTP: {error}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    let rpc_backend = RpcBackend::new(rpc_config).expect("Failed to create RPC backend");

    let mut indexer = Indexer::new(indexer_config, shutdown.subscribe(), rpc_backend.clone());
    let mut api_server = ApiServer::new(
        api_server_config,
        shutdown.subscribe(),
        rpc_backend,
        ohttp_gateway,
        ohttp_config,
    );

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
