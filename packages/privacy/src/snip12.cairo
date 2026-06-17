use core::ecdsa::check_ecdsa_signature;
use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::{PoseidonTrait, poseidon_hash_span};
use openzeppelin::account::extensions::src9::snip12_utils::CallStructHash;
use openzeppelin::utils::cryptography::snip12::{StarknetDomain, StructHash};
use starknet::account::Call;
use starknet::{ContractAddress, get_tx_info};

pub const SNIP12_NAME: felt252 = 'Screening';
// Numeric felt (not shortstring `'2'`), matching the starknet.js/starknet-py convention.
pub const SNIP12_VERSION: felt252 = 2;

// SNIP-12 domain for the generic `CallSet` authorization message.
pub const CALL_SET_SNIP12_NAME: felt252 = 'CallSet';
pub const CALL_SET_SNIP12_VERSION: felt252 = 1;

// SNIP-12 has no `u64` primitive; the type string widens `issued_at` to `u128`,
// while the Cairo field stays `u64`. Both reduce to the same felt under Poseidon,
// so the encoding matches off-chain signers that follow OZ's `Permit` convention.
const DEPOSITOR_VALIDATION_TYPE_HASH: felt252 = selector!(
    "\"DepositorValidation\"(\"depositor\":\"ContractAddress\",\"issued_at\":\"u128\")",
);

#[derive(Copy, Drop, Hash)]
pub(crate) struct DepositorValidation {
    pub(crate) depositor: ContractAddress,
    pub(crate) issued_at: u64,
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

/// Checks for off-chain screening attestation signature validity.
///
/// Constructs the SNIP-12 `DepositorValidation { depositor, issued_at }` typed message hash,
/// and returns true if the `attestation.signature` is a valid signature of that hash
/// by `signer_public_key`.
/// This function verifies the signature validity only,
/// it DOES NOT assert attestation age.
/// Attestation expiry must be checked by the caller.
pub fn is_screening_attestation_valid(
    depositor: ContractAddress, attestation: ScreeningAttestation, signer_public_key: felt252,
) -> bool {
    let validation = DepositorValidation { depositor, issued_at: attestation.issued_at };
    let message_hash = compute_message_hash(@validation, signer_public_key);
    let (r, s) = attestation.signature;
    check_ecdsa_signature(message_hash, signer_public_key, r, s)
}

/// SNIP-12 off-chain message hash for a `DepositorValidation`.
///
/// `signer` is the trusted signer's STARK-curve public key (felt252). The
/// SNIP-12 envelope binds the hash to this identity. Exposed so off-chain
/// tooling (TS/Python reference signers, test-vector generators) can derive
/// the exact hash the verifier will check against.
pub(crate) fn compute_message_hash(validation: @DepositorValidation, signer: felt252) -> felt252 {
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

// SNIP-12 type hash `CallSet`.
const CALL_SET_TYPE_HASH: felt252 = selector!(
    "\"CallSet\"(\"Calls\":\"Call*\")\"Call\"(\"To\":\"ContractAddress\",\"Selector\":\"selector\",\"Calldata\":\"felt*\")",
);

/// A generic authorization over a set of `calls` — the depositor attests to exactly these calls,
/// independent of any transaction metadata. The off-chain signer (a "legacy" SN wallet) signs this
/// SNIP-12 message; the pool reconstructs the hash and checks it via the account's
/// `is_valid_signature`.
#[derive(Drop)]
pub struct CallSet {
    pub calls: Span<Call>,
}

impl CallSetStructHashImpl of StructHash<CallSet> {
    fn hash_struct(self: @CallSet) -> felt252 {
        let mut hashed_calls = array![];
        for call in *self.calls {
            hashed_calls.append(call.hash_struct());
        }
        PoseidonTrait::new()
            .update_with(CALL_SET_TYPE_HASH)
            .update_with(poseidon_hash_span(hashed_calls.span()))
            .finalize()
    }
}

/// SNIP-12 off-chain message hash for a `CallSet` authorized by `signer`
/// SNIP-12 message binds the signing account, matching starknet.js
/// `typedData.getMessageHash(td, accountAddress)`).
pub fn compute_call_set_hash(signer: ContractAddress, calls: Span<Call>) -> felt252 {
    let domain = StarknetDomain {
        name: CALL_SET_SNIP12_NAME,
        version: CALL_SET_SNIP12_VERSION,
        chain_id: get_tx_info().unbox().chain_id,
        revision: 1,
    };
    let call_set = CallSet { calls };
    PoseidonTrait::new()
        .update_with('StarkNet Message')
        .update_with(domain.hash_struct())
        .update_with(signer)
        .update_with(call_set.hash_struct())
        .finalize()
}
