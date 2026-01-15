#![doc = include_str!("../README.md")]

use clap::Parser;
use discovery_service::api_server::{ApiServer, ApiServerConfig};
use discovery_service::indexer::{Indexer, IndexerConfig};
use discovery_service::shutdown::Shutdown;
use discovery_service::store::SqliteStore;
use tokio::task::JoinHandle;
use tracing::{error, info, subscriber::set_global_default};
use tracing_subscriber::filter::EnvFilter;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
#[command(propagate_version = true)]
struct Cli {
    /// Logging level (off, error, warn, info, debug, trace). Overrides RUST_LOG.
    #[arg(long)]
    log_level: Option<String>,

    /// Drop the existing database and reindex from scratch.
    #[arg(long)]
    reindex: bool,
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
    if let Ok(db_path) = std::env::var("DB_PATH") {
        indexer_config.db_path = db_path;
    }
    let db_path = indexer_config.db_path.clone();

    let mut api_config = ApiServerConfig::default();
    if let Ok(api_host) = std::env::var("API_HOST") {
        api_config.api_host = api_host;
    }

    // Initialize database before starting services
    info!("Initializing database at {}", db_path);
    if let Err(e) = SqliteStore::writer(&db_path).await {
        error!("Failed to initialize database: {}", e);
        std::process::exit(1);
    }

    if cli.reindex {
        let db_path = std::path::Path::new(&indexer_config.db_path);
        if db_path.exists() {
            if let Err(e) = std::fs::remove_file(db_path) {
                error!("Failed to remove database for reindexing: {}", e);
                std::process::exit(1);
            }
            info!("Removed existing database for reindexing");
        }
    }

    let mut indexer = Indexer::new(indexer_config, shutdown.subscribe());
    let api_server = ApiServer::new(api_config, db_path, shutdown.subscribe());

    let indexer_handle = tokio::spawn(async move { indexer.run().await });
    let api_handle = tokio::spawn(async move { api_server.run().await });
    let shutdown_handle = tokio::spawn(async move { shutdown.run().await });

    match tokio::try_join!(
        flatten(indexer_handle),
        flatten(api_handle),
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

async fn flatten<T>(handle: JoinHandle<Result<T, ()>>) -> Result<T, ()> {
    match handle.await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(()),
    }
}
