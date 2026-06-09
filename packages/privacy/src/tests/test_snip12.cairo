use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::signature::{KeyPairTrait, SignerTrait};
use snforge_std::{start_cheat_chain_id, test_address};
use crate::snip12::{
    DepositorValidation, ScreeningAttestation, compute_message_hash, is_screening_attestation_valid,
};

const TEST_CHAIN_ID: felt252 = 'TEST';
const SIGNER_SECRET: felt252 = 'PRIVACY_DEPOSITOR_VALIDATION_SK';
const OTHER_SIGNER_SECRET: felt252 = 'OTHER_SIGNER_SK';
const ISSUED_AT: u64 = 1_700_000_000;

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

/// Signs `sample_validation()` under the trusted signer and returns the key, the validation it
/// signed (for the depositor/issued_at), and the attestation carrying that signature.
fn fresh_signed() -> (StarkCurveKeyPair, DepositorValidation, ScreeningAttestation) {
    setup_chain_id();
    let key = trusted_signer();
    let validation = sample_validation();
    let signature = sign_validation(key, validation);
    let attestation = ScreeningAttestation { issued_at: validation.issued_at, signature };
    (key, validation, attestation)
}

#[test]
fn test_valid_signature_returns_true() {
    let (key, validation, attestation) = fresh_signed();
    assert!(is_screening_attestation_valid(validation.depositor, attestation, key.public_key));
}

#[test]
fn test_wrong_signer_returns_false() {
    let (_, validation, attestation) = fresh_signed();
    assert!(
        !is_screening_attestation_valid(
            validation.depositor, attestation, other_signer().public_key,
        ),
    );
}

#[test]
fn test_tampered_depositor_returns_false() {
    let (key, _, attestation) = fresh_signed();
    // A different depositor than the one the attestation was signed for.
    let tampered_depositor = 0xDEAD.try_into().unwrap();
    assert!(!is_screening_attestation_valid(tampered_depositor, attestation, key.public_key));
}

#[test]
fn test_tampered_issued_at_returns_false() {
    let (key, validation, attestation) = fresh_signed();
    let tampered = ScreeningAttestation {
        issued_at: attestation.issued_at + 1, signature: attestation.signature,
    };
    assert!(!is_screening_attestation_valid(validation.depositor, tampered, key.public_key));
}

#[test]
fn test_tampered_signature_r_returns_false() {
    let (key, validation, attestation) = fresh_signed();
    let (signature_r, signature_s) = attestation.signature;
    let tampered = ScreeningAttestation {
        issued_at: attestation.issued_at, signature: (signature_r + 1, signature_s),
    };
    assert!(!is_screening_attestation_valid(validation.depositor, tampered, key.public_key));
}
