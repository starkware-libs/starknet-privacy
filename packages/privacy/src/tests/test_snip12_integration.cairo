//! SNIP-12 `compute_call_set_hash` regression tests.
//!
//! Verifies the Cairo contract's `compute_call_set_hash` function:
//! - Non-trivial output: hashes are non-zero and different from each other
//! - Determinism: same inputs always produce same output
//! - additional_data binding: different additional_data produces different hash
//!
//! Note: starknet.js SDK does NOT expose a SNIP-12 typed-data signing function,
//! so cross-language golden value validation is not applicable here.
//! The SDK's `additional_data` usage is limited to screening attestation Serde
//! encoding, already covered by `screening-calldata.test.ts`.

use snforge_std::{start_cheat_chain_id, test_address};
use starknet::account::Call;
use crate::snip12::compute_call_set_hash;

fn setup_chain_id() {
    start_cheat_chain_id(test_address(), 'TEST');
}

#[test]
fn test_call_set_hash_empty_calls_empty_data() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let hash = compute_call_set_hash(signer, [].span(), [].span());
    assert!(hash != 0);
}

#[test]
fn test_call_set_hash_single_call_empty_data() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let calls = array![
        Call {
            to: 0x111.try_into().unwrap(),
            selector: selector!("approve"),
            calldata: array![0x1, 0x2].span(),
        },
    ];
    let hash = compute_call_set_hash(signer, calls.span(), [].span());
    assert!(hash != 0);
}

#[test]
fn test_call_set_hash_is_deterministic() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let calls = array![
        Call {
            to: 0x111.try_into().unwrap(),
            selector: selector!("approve"),
            calldata: array![0x1, 0x2].span(),
        },
    ];
    let hash1 = compute_call_set_hash(signer, calls.span(), [].span());
    let hash2 = compute_call_set_hash(signer, calls.span(), [].span());
    assert!(hash1 == hash2);
}

#[test]
fn test_call_set_hash_additional_data_changes_hash() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let calls = array![
        Call {
            to: 0x111.try_into().unwrap(),
            selector: selector!("approve"),
            calldata: array![0x1, 0x2].span(),
        },
    ];
    let hash_empty = compute_call_set_hash(signer, calls.span(), [].span());
    let hash_with = compute_call_set_hash(signer, calls.span(), array![0xa, 0xb].span());
    assert!(hash_empty != hash_with);
}
