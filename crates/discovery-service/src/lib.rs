//! Discovery service library.
//!
//! This crate provides:
//! - RPC-based storage backend for reading privacy contract state
//! - Indexer for Starknet new heads subscription

pub mod indexer;
pub mod rpc_backend;
pub mod shutdown;

// Re-export storage types from discovery-core for convenience
pub use discovery_core::storage;
