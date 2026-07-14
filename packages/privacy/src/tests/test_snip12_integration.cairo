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
use openzeppelin::utils::cryptography::snip12::{StarknetDomain, StructHash};
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
fn debug_selector() {
    let call = Call {
        to: 0x111.try_into().unwrap(),
        selector: selector!("approve"),
        calldata: array![].span(),
    };
    // assert(false) with selector in error message to reveal value
    assert(false, call.selector);
}

#[test]
fn debug_call_set_hash_empty() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let h = compute_call_set_hash(signer, [].span(), [].span());
    assert(false, h);
}

#[test]
fn debug_call_set_hash_single_call() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let call: Call = Call {
        to: 0x111.try_into().unwrap(),
        selector: 'approve',
        calldata: array![1, 2].span(),
    };
    let h = compute_call_set_hash(signer, array![call].span(), [].span());
    assert(false, h);
}

#[test]
fn debug_call_set_hash_single_call_with_data() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let call: Call = Call {
        to: 0x111.try_into().unwrap(),
        selector: 'approve',
        calldata: array![1].span(),
    };
    let h = compute_call_set_hash(
        signer, array![call].span(), array![0xa, 0xb].span(),
    );
    assert(false, h);
}

#[test]
fn debug_call_set_hash_diff_signer() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1235.try_into().unwrap();
    let call: Call = Call {
        to: 0x111.try_into().unwrap(),
        selector: 'approve',
        calldata: array![1, 2].span(),
    };
    let h = compute_call_set_hash(signer, array![call].span(), [].span());
    assert(false, h);
}

#[test]
fn debug_domain_hash() {
    setup_chain_id();
    let domain = StarknetDomain {
        name: 'StarkNet Message',
        version: 1,
        chain_id: 'TEST',
        revision: '1',
    };
    let h = domain.hash_struct();
    assert(false, h);
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

#[test]
fn test_call_set_hash_multiple_calls() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let calls = array![
        Call {
            to: 0x111.try_into().unwrap(),
            selector: selector!("approve"),
            calldata: array![0x1].span(),
        },
        Call {
            to: 0x222.try_into().unwrap(),
            selector: selector!("transfer"),
            calldata: array![0x2, 0x3].span(),
        },
    ];
    let hash = compute_call_set_hash(signer, calls.span(), [].span());
    assert!(hash != 0);
}

#[test]
fn test_call_set_hash_large_additional_data() {
    setup_chain_id();
    let signer: starknet::ContractAddress = 0x1234.try_into().unwrap();
    let calls = array![
        Call {
            to: 0x111.try_into().unwrap(),
            selector: selector!("approve"),
            calldata: array![0x1].span(),
        },
    ];
    // 32 elements — well within field arithmetic bounds.
    let large_data = array![
        0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8,
        0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf, 0x10,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
    ].span();
    let hash = compute_call_set_hash(signer, calls.span(), large_data);
    assert!(hash != 0);
}
