//! Discovery service library.
//!
//! This crate provides:
//! - Centralized configuration loading from TOML with env var overrides
//! - RPC-based storage backend for reading privacy contract state
//! - Indexer for Starknet new heads subscription
//! - Chain state tracking for canonical block verification and recent head retrieval
//! - API server with health endpoint

pub mod api;
pub mod chain_state;
pub mod config;
pub mod indexer;
pub mod rpc_backend;
pub mod shutdown;
