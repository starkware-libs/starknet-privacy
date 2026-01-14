//! Discovery service library.
//!
//! This crate provides:
//! - RPC-based storage backend for reading privacy contract state
//! - Indexer for Starknet new heads subscription

pub mod indexer;
pub mod rpc_backend;
pub mod shutdown;
