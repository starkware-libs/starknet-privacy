//! Discovery service library.
//!
//! This crate provides:
//! - RPC-based storage backend for reading privacy contract state
//! - Indexer for Starknet new heads subscription
//! - Chain state tracking for canonical block verification and recent head retrieval

pub mod chain_state;
pub mod indexer;
pub mod rpc_backend;
pub mod shutdown;
