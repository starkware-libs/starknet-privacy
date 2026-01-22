//! Storage backends for accessing the privacy contract.

pub mod mock;
pub mod rpc;

pub use mock::MockBackend;
pub use rpc::{RpcBackend, RpcConfig, RpcSnapshot};
