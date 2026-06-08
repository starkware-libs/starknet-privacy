//! Dev CLI: run the online FETCH stage and write the snapshot bytes to a file.
//!
//! Production drives `solvency_audit::fetch::fetch` directly and pushes the bytes
//! over vsock; this binary is for local runs and tests (DESIGN.md §9).

use std::error::Error;
use std::path::PathBuf;

use clap::Parser;
use solvency_audit::fetch::fetch;
use starknet_types_core::felt::Felt;
use url::Url;

#[derive(Parser)]
#[command(about = "Fetch a privacy-pool storage snapshot for offline audit")]
struct Args {
    /// JSON-RPC endpoint of a StarkNet node (full or archive).
    #[arg(long)]
    rpc_url: Url,
    /// Privacy-pool contract address (hex).
    #[arg(long)]
    contract: String,
    /// First block to fold (inclusive); use the deploy block or earlier.
    #[arg(long)]
    from: u64,
    /// Pinned audit block (inclusive); should be final on L1.
    #[arg(long)]
    to: u64,
    /// Output path for the snapshot JSON bytes.
    #[arg(long)]
    out: PathBuf,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args = Args::parse();
    let contract = Felt::from_hex(&args.contract)?;

    let bytes = fetch(args.rpc_url, contract, args.from, args.to).await?;
    std::fs::write(&args.out, &bytes)?;

    eprintln!(
        "wrote {} bytes for contract {contract:#x} (blocks {}..={}) to {}",
        bytes.len(),
        args.from,
        args.to,
        args.out.display()
    );
    Ok(())
}
