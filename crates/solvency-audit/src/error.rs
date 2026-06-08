//! Errors surfaced by the audit stages.
//!
//! Every way an audit can fail lives in this one enum so the full failure
//! surface is visible in a single place; storage and JSON failures fold in via
//! `From`. The walk stage produces the storage/overflow variants; the `analyze`
//! stage adds the snapshot-parsing and auditor-key variants.

use discovery_core::storage_backend::StorageError;
use starknet_types_core::felt::Felt;
use thiserror::Error;

/// Anything that can go wrong during an audit.
#[derive(Debug, Error)]
pub enum AuditError {
    /// A storage read failed while walking the snapshot.
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// Summing unspent note amounts for a token exceeded `u128`. A correct
    /// snapshot never overflows (a token's whole supply fits in `u128`), so
    /// reaching this means corrupt or crafted note data — the audit fails loud
    /// rather than reporting a clamped, wrong Σ(unspent).
    #[error("unspent-note sum overflowed u128 for token {token:#x} at note index {index}")]
    NoteAmountOverflow { token: Felt, index: u64 },
    /// The snapshot bytes are not valid JSON for a `Snapshot`.
    #[error("invalid snapshot JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    /// `meta` is missing a required key.
    #[error("snapshot meta is missing `{0}`")]
    MissingMeta(&'static str),
    /// A `meta` value is not a valid felt.
    #[error("snapshot meta `{0}` is not a felt")]
    InvalidMetaFelt(&'static str),
    /// `derive_public_key(auditor_private_key)` does not match `meta`'s auditor
    /// public key — the wrong key for this snapshot (DESIGN.md §5.2 pre-check).
    #[error("auditor key mismatch: meta has {meta:#x}, supplied key derives {derived:#x}")]
    WrongAuditorKey { meta: Felt, derived: Felt },
}
