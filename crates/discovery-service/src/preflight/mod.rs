//! Preflight endpoint for transfer readiness checks.
//!
//! Provides the `POST /v1/discovery/preflight` endpoint.

mod handler;
mod types;

pub use handler::preflight_handler;
pub use types::{PreflightRequest, PreflightResponse};
