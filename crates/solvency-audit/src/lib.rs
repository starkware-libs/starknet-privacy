//! Solvency & completeness audit for the privacy pool.
//!
//! Two stages exchange a JSON snapshot of the pool's contract storage (see
//! `DESIGN.md`): an online `fetch` builds it, and an offline `analyze` (run in
//! an enclave) classifies every slot and sums unspent notes. This crate holds
//! the shared snapshot type and those stages.

pub mod backend;
pub mod error;
pub mod fetch;
pub mod owned_slots;
pub mod snapshot;
pub mod state_source;
pub mod walk;
