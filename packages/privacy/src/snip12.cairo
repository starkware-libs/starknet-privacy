use core::ecdsa::check_ecdsa_signature;
use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::PoseidonTrait;
use openzeppelin::utils::cryptography::snip12::{StarknetDomain, StructHash};
use starknet::{ContractAddress, get_tx_info};

pub const SNIP12_NAME: felt252 = 'Screening';
// Numeric felt (not shortstring `'2'`), matching the starknet.js/starknet-py convention.
pub const SNIP12_VERSION: felt252 = 2;

// SNIP-12 has no `u64` primitive; the type string widens `issued_at` to `u128`,
// while the Cairo field stays `u64`. Both reduce to the same felt under Poseidon,
// so the encoding matches off-chain signers that follow OZ's `Permit` convention.
pub const DEPOSITOR_VALIDATION_TYPE_HASH: felt252 = selector!(
    "\"DepositorValidation\"(\"depositor\":\"ContractAddress\",\"issued_at\":\"u128\")",
);

#[derive(Copy, Drop, Hash)]
pub struct DepositorValidation {
    pub depositor: ContractAddress,
    pub issued_at: u64,
}

#[derive(Copy, Drop, Debug, PartialEq)]
pub enum ValidationError {
    Expired,
    FutureDated,
    InvalidSignature,
}

/// Verifies an off-chain depositor validation signed under SNIP-12 by `signer_public_key`.
///
/// `now` is the unix-second timestamp the caller treats as authoritative
/// (typically `starknet::get_block_timestamp()`). `max_age` is the maximum
/// allowed staleness in seconds; the validation is rejected when
/// `now - validation.issued_at > max_age`. `FutureDated` is reported when
/// `validation.issued_at > now` so clock skew is distinguishable from a stale
/// signature in caller telemetry.
pub fn verify_depositor_validation(
    validation: DepositorValidation,
    signature: (felt252, felt252),
    signer_public_key: felt252,
    now: u64,
    max_age: u64,
) -> Result<(), ValidationError> {
    if validation.issued_at > now {
        return Err(ValidationError::FutureDated);
    }
    if now - validation.issued_at > max_age {
        return Err(ValidationError::Expired);
    }
    let message_hash = compute_message_hash(@validation, signer_public_key);
    let (signature_r, signature_s) = signature;
    if check_ecdsa_signature(message_hash, signer_public_key, signature_r, signature_s) {
        Ok(())
    } else {
        Err(ValidationError::InvalidSignature)
    }
}

/// SNIP-12 off-chain message hash for a `DepositorValidation`.
///
/// `signer` is the trusted signer's STARK-curve public key (felt252). The
/// SNIP-12 envelope binds the hash to this identity. Exposed so off-chain
/// tooling (TS/Python reference signers, test-vector generators) can derive
/// the exact hash the verifier will check against.
pub fn compute_message_hash(validation: @DepositorValidation, signer: felt252) -> felt252 {
    let domain = StarknetDomain {
        name: SNIP12_NAME,
        version: SNIP12_VERSION,
        chain_id: get_tx_info().unbox().chain_id,
        revision: 1,
    };
    PoseidonTrait::new()
        .update_with('StarkNet Message')
        .update_with(domain.hash_struct())
        .update_with(signer)
        .update_with(validation.hash_struct())
        .finalize()
}

impl DepositorValidationStructHashImpl of StructHash<DepositorValidation> {
    fn hash_struct(self: @DepositorValidation) -> felt252 {
        PoseidonTrait::new()
            .update_with(DEPOSITOR_VALIDATION_TYPE_HASH)
            .update_with(*self)
            .finalize()
    }
}
