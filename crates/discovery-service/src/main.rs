#![doc = include_str!("../README.md")]

use clap::Parser;
use tokio::task::JoinHandle;
use tracing::{error, info, subscriber::set_global_default};
use tracing_subscriber::filter::EnvFilter;

use crate::shutdown::Shutdown;

mod shutdown;

#[derive(Parser)]
#[command(author, version, about, long_about = None)]
#[command(propagate_version = true)]
struct Cli {
    /// Logging level (off, error, warn, info, debug, trace). Overrides RUST_LOG.
    #[arg(long)]
    log_level: Option<String>,
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
    let shutdown_handle = tokio::spawn(async move { shutdown.run().await });

    match tokio::try_join!(flatten(shutdown_handle)) {
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
