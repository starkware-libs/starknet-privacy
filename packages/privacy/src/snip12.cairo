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

/// Off-chain screening attestation relayed into `apply_actions` for deposits.
///
/// Carries everything the contract needs to reconstruct and verify the screener's signature
/// except the depositor and chain-id which are taken from the context.
#[derive(Serde, Copy, Drop)]
pub struct ScreeningAttestation {
    pub issued_at: u64,
    pub signature: (felt252, felt252),
}

/// Verifies an off-chain depositor validation signed under SNIP-12 by `signer_public_key`.
///
/// Returns `true` iff `signature` is a valid STARK-curve ECDSA signature, by
/// `signer_public_key`, over the SNIP-12 message hash of `validation`.
/// This function verifies the signature validity only,
/// it DOES NOT assert validation age.
/// Attestation expiry must be checked by the caller.
pub fn verify_depositor_validation(
    validation: DepositorValidation, signature: (felt252, felt252), signer_public_key: felt252,
) -> bool {
    let message_hash = compute_message_hash(@validation, signer_public_key);
    let (signature_r, signature_s) = signature;
    check_ecdsa_signature(message_hash, signer_public_key, signature_r, signature_s)
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
