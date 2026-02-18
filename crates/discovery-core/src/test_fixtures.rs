//! Shared test fixtures for discovery-core tests.
//!
//! This module provides common fixture loading utilities for tests
//! across different modules.

// Allow unused fields in fixture structs - they map to JSON files and
// not all fields are used by current tests.
#![allow(dead_code)]

use std::collections::HashMap;

use serde::Deserialize;
use starknet_types_core::felt::Felt;

use crate::io_budget::IoBudget;
use crate::privacy_pool::types::SecretFelt;

/// Devnet fixture loaded from devnet-state.json.
#[derive(Deserialize)]
pub struct DevnetFixture {
    pub constants: DevnetConstants,
    pub slots: HashMap<Felt, Felt>,
}

/// Constants from the devnet fixture.
#[derive(Deserialize)]
pub struct DevnetConstants {
    pub contract_address: Felt,
    pub alice_address: Felt,
    pub alice_viewing_key: Felt,
    pub bob_address: Felt,
    pub bob_viewing_key: Felt,
    pub admin_address: Felt,
    pub eth_token: Felt,
    pub strk_token: Felt,
}

/// Cairo reference fixture loaded from cairo-reference-data.json.
#[derive(Deserialize)]
pub struct CairoRefFixture {
    pub inputs: CairoRefInputs,
    pub outputs: CairoRefOutputs,
    pub slots: CairoRefSlots,
}

/// Inputs from the Cairo reference fixture.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CairoRefInputs {
    pub sender: Felt,
    pub recipient: Felt,
    pub sender_private_key: Felt,
    pub recipient_public_key: Felt,
    pub channel_key: Felt,
    pub token: Felt,
    pub index: u64,
    pub salt: Felt,
    pub shared_x: Felt,
    pub ephemeral_secret: Felt,
    pub amount: u64,
    pub recipient_private_key: Felt,
    pub recipient_public_key_derived: Felt,
    pub auditor_private_key: Felt,
    pub auditor_public_key: Felt,
    pub user_addr: Felt,
    pub user_private_key: Felt,
    pub channel_marker: Felt,
    pub subchannel_id: Felt,
    pub subchannel_marker: Felt,
    pub note_id: Felt,
    pub nullifier: Felt,
}

/// Outputs from the Cairo reference fixture.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CairoRefOutputs {
    pub channel_key: Felt,
    pub channel_marker: Felt,
    pub subchannel_id: Felt,
    pub subchannel_marker: Felt,
    pub note_id: Felt,
    pub nullifier: Felt,
    pub enc_amount_hash: Felt,
    pub enc_token_hash: Felt,
    pub enc_private_key_hash: Felt,
    pub enc_channel_key_hash: Felt,
    pub enc_sender_addr_hash: Felt,
    pub enc_recipient_addr_hash: Felt,
    pub outgoing_channel_id: Felt,
    pub enc_subchannel_salt: Felt,
    pub enc_subchannel_token: Felt,
    pub enc_channel_ephemeral_pubkey: Felt,
    pub enc_channel_key: Felt,
    pub enc_channel_sender_addr: Felt,
    pub enc_note_amount: Felt,
    pub dec_note_amount: u64,
    pub enc_outgoing_salt: Felt,
    pub enc_outgoing_recipient_addr: Felt,
    pub enc_private_key_ephemeral_pubkey: Felt,
    pub enc_private_key_value: Felt,
    pub enc_user_addr_ephemeral_pubkey: Felt,
    pub enc_user_addr_value: Felt,
}

/// Storage slot addresses from the Cairo reference fixture.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CairoRefSlots {
    pub auditor_public_key_address: Felt,
    pub sender_public_key_address: Felt,
    pub recipient_public_key_address: Felt,
    pub enc_private_key_auditor_pub_key_address: Felt,
    pub enc_private_key_ephemeral_address: Felt,
    pub enc_private_key_enc_key_address: Felt,
    pub channel_exists_address: Felt,
    pub recipient_channels_base_address: Felt,
    pub recipient_channels_element_address: Felt,
    pub subchannel_exists_address: Felt,
    pub subchannel_tokens_salt_address: Felt,
    pub subchannel_tokens_enc_token_address: Felt,
    pub notes_address: Felt,
    pub nullifiers_address: Felt,
}

/// Loads the devnet fixture from the embedded JSON file.
pub fn load_devnet_fixture() -> DevnetFixture {
    const JSON: &str = include_str!("../tests/fixtures/devnet-state.json");
    serde_json::from_str(JSON).expect("failed to parse devnet fixture")
}

/// Loads the Cairo reference fixture from the embedded JSON file.
pub fn load_cairo_ref_fixture() -> CairoRefFixture {
    const JSON: &str = include_str!("../tests/fixtures/cairo-reference-data.json");
    serde_json::from_str(JSON).expect("failed to parse Cairo reference fixture")
}

/// Helper to discover channels and get the first channel key for a recipient.
pub async fn get_channel_key(
    backend: &crate::storage_backend::MockBackend,
    recipient: starknet_types_core::felt::Felt,
    private_key: &starknet_types_core::felt::Felt,
) -> Option<starknet_types_core::felt::Felt> {
    use crate::discovery::incoming_channels::{
        discover_incoming_channels, get_incoming_channel_count,
    };

    let budget = IoBudget::new(100);
    let count = get_incoming_channel_count(backend, recipient, &budget)
        .await
        .ok()??;
    let key = SecretFelt::new(*private_key);
    let result = discover_incoming_channels(backend, recipient, &key, 0, count as usize, &budget)
        .await
        .ok()?;

    result.channels.first().map(|c| c.channel_key)
}

/// Helper to discover subchannels and get the first token for a channel.
pub async fn get_subchannel_token(
    backend: &crate::storage_backend::MockBackend,
    channel_key: starknet_types_core::felt::Felt,
) -> Option<starknet_types_core::felt::Felt> {
    use crate::discovery::subchannels::discover_subchannels;

    let budget = IoBudget::new(100);
    let result = discover_subchannels(backend, channel_key, 0, usize::MAX, &budget)
        .await
        .ok()?;

    result.subchannels.first().map(|s| s.token)
}
