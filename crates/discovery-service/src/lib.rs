//! Discovery service library.
//!
//! This crate provides the RPC-based storage backend for reading privacy contract
//! state from a StarkNet node via JSON-RPC.

pub mod rpc_backend;

// Re-export storage types from discovery-core for convenience
pub use discovery_core::storage;
