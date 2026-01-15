//! Discovery service library.
//!
//! This crate provides:
//! - RPC-based storage backend for reading privacy contract state
//! - Indexer for Starknet new heads subscription

pub mod api_server;
pub mod indexer;
pub mod rpc_backend;
pub mod shutdown;
pub mod store;

// Re-export storage types from discovery-core for convenience
pub use discovery_core::storage;
