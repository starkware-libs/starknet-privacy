//! Errors surfaced while walking and reconciling a pool snapshot.
//!
//! Audit-specific failures live here in one enum so every way an audit can fail
//! is visible in a single place; storage failures fold in via `From`.

use discovery_core::storage_backend::StorageError;
use starknet_types_core::felt::Felt;
use thiserror::Error;

/// Anything that can go wrong during an audit walk.
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
}
