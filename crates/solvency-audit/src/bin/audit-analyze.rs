//! Dev CLI: run the offline ANALYZE stage on a snapshot file and write the
//! classified snapshot back out, printing the audit summary.
//!
//! Production runs `solvency_audit::work::analyze` inside the enclave on bytes
//! received over vsock; this binary is for local runs and tests (DESIGN.md §9).

use std::error::Error;
use std::path::PathBuf;

use clap::Parser;
use solvency_audit::work::analyze;
use starknet_types_core::felt::Felt;

#[derive(Parser)]
#[command(about = "Classify a privacy-pool snapshot and sum unspent notes")]
struct Args {
    /// Input snapshot JSON bytes (from `audit-fetch`).
    #[arg(long)]
    input: PathBuf,
    /// Auditor private key (hex). Stays local; never written to the output.
    #[arg(long)]
    auditor_key: String,
    /// Output path for the classified snapshot JSON bytes.
    #[arg(long)]
    out: PathBuf,
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = Args::parse();
    let auditor_key = Felt::from_hex(&args.auditor_key)?;

    let snapshot_bytes = std::fs::read(&args.input)?;
    let (out_bytes, summary) = analyze(&snapshot_bytes, auditor_key)?;
    std::fs::write(&args.out, &out_bytes)?;

    eprintln!("audit summary:");
    eprintln!("  users processed:          {}", summary.n_users);
    eprintln!(
        "  recovery failures:        {}",
        summary.n_recovery_failures
    );
    eprintln!(
        "  public-key mismatches:    {}",
        summary.n_public_key_mismatches
    );
    eprintln!(
        "  foreign auditor-key refs: {} (non-zero ⇒ key rotation)",
        summary.n_foreign_auditor_key_refs
    );
    eprintln!(
        "  anomaly slots:            {}",
        summary.anomaly_slots.len()
    );
    eprintln!("  slots by kind:");
    for (kind, count) in &summary.kind_counts {
        eprintln!("    {kind}: {count}");
    }
    eprintln!("wrote classified snapshot to {}", args.out.display());
    Ok(())
}
