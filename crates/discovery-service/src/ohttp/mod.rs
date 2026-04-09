//! Oblivious HTTP (OHTTP, RFC 9458) support for the discovery service.
//!
//! When enabled, provides application-layer encryption of HTTP requests
//! and responses using HPKE, independent of TLS. The [`OhttpLayer`] is
//! a Tower middleware that transparently decapsulates incoming
//! `message/ohttp-req` requests and encapsulates responses as
//! `message/ohttp-res`, leaving handlers completely unchanged.

pub mod gateway;
pub mod handlers;
pub mod layer;
