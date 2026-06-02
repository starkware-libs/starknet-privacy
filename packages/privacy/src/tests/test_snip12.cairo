use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::signature::{KeyPairTrait, SignerTrait};
use snforge_std::{start_cheat_chain_id, test_address};
use crate::snip12::{
    DepositorValidation, ValidationError, compute_message_hash, verify_depositor_validation,
};

const TEST_CHAIN_ID: felt252 = 'TEST';
const SIGNER_SECRET: felt252 = 'PRIVACY_DEPOSITOR_VALIDATION_SK';
const OTHER_SIGNER_SECRET: felt252 = 'OTHER_SIGNER_SK';
const ISSUED_AT: u64 = 1_700_000_000;
const MAX_AGE: u64 = 60;

fn setup_chain_id() {
    start_cheat_chain_id(test_address(), TEST_CHAIN_ID);
}

fn trusted_signer() -> StarkCurveKeyPair {
    KeyPairTrait::from_secret_key(SIGNER_SECRET)
}

fn other_signer() -> StarkCurveKeyPair {
    KeyPairTrait::from_secret_key(OTHER_SIGNER_SECRET)
}

fn sample_validation() -> DepositorValidation {
    DepositorValidation { depositor: 0x1234.try_into().unwrap(), issued_at: ISSUED_AT }
}

fn sign_validation(key: StarkCurveKeyPair, validation: DepositorValidation) -> (felt252, felt252) {
    let hash = compute_message_hash(@validation, key.public_key);
    key.sign(hash).unwrap()
}

fn fresh_signed() -> (StarkCurveKeyPair, DepositorValidation, (felt252, felt252)) {
    setup_chain_id();
    let key = trusted_signer();
    let validation = sample_validation();
    let signature = sign_validation(key, validation);
    (key, validation, signature)
}

#[test]
fn test_fresh_returns_ok() {
    let (key, validation, signature) = fresh_signed();
    verify_depositor_validation(validation, signature, key.public_key, ISSUED_AT, MAX_AGE).unwrap();
}

#[test]
fn test_at_max_age_boundary_returns_ok() {
    let (key, validation, signature) = fresh_signed();
    verify_depositor_validation(validation, signature, key.public_key, ISSUED_AT + MAX_AGE, MAX_AGE)
        .unwrap();
}

#[test]
fn test_expired_one_second_past_returns_expired() {
    let (key, validation, signature) = fresh_signed();
    let result = verify_depositor_validation(
        validation, signature, key.public_key, ISSUED_AT + MAX_AGE + 1, MAX_AGE,
    );
    assert!(result == Err(ValidationError::Expired));
}

#[test]
fn test_future_dated_returns_future_dated() {
    let (key, validation, signature) = fresh_signed();
    let result = verify_depositor_validation(
        validation, signature, key.public_key, ISSUED_AT - 1, MAX_AGE,
    );
    assert!(result == Err(ValidationError::FutureDated));
}

#[test]
fn test_wrong_signer_returns_invalid_signature() {
    let (_, validation, signature) = fresh_signed();
    let result = verify_depositor_validation(
        validation, signature, other_signer().public_key, ISSUED_AT, MAX_AGE,
    );
    assert!(result == Err(ValidationError::InvalidSignature));
}

#[test]
fn test_tampered_depositor_returns_invalid_signature() {
    let (key, validation, signature) = fresh_signed();
    let tampered = DepositorValidation {
        depositor: 0xDEAD.try_into().unwrap(), issued_at: validation.issued_at,
    };
    let result = verify_depositor_validation(
        tampered, signature, key.public_key, ISSUED_AT, MAX_AGE,
    );
    assert!(result == Err(ValidationError::InvalidSignature));
}

#[test]
fn test_tampered_issued_at_returns_invalid_signature() {
    let (key, validation, signature) = fresh_signed();
    let tampered = DepositorValidation {
        depositor: validation.depositor, issued_at: validation.issued_at + 1,
    };
    let result = verify_depositor_validation(
        tampered, signature, key.public_key, ISSUED_AT + 1, MAX_AGE,
    );
    assert!(result == Err(ValidationError::InvalidSignature));
}

#[test]
fn test_tampered_signature_r_returns_invalid_signature() {
    let (key, validation, (signature_r, signature_s)) = fresh_signed();
    let tampered_signature = (signature_r + 1, signature_s);
    let result = verify_depositor_validation(
        validation, tampered_signature, key.public_key, ISSUED_AT, MAX_AGE,
    );
    assert!(result == Err(ValidationError::InvalidSignature));
}
