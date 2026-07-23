use core::ecdsa::check_ecdsa_signature;
use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::{PoseidonTrait, poseidon_hash_span};
use openzeppelin::account::extensions::src9::snip12_utils::CallStructHash;
use openzeppelin::utils::cryptography::snip12::{StarknetDomain, StructHash};
use starknet::account::Call;
use starknet::{ContractAddress, get_tx_info};

pub const SCREENING_SNIP12_NAME: felt252 = 'Screening';
// Numeric felt (not shortstring `'2'`), matching the starknet.js/starknet-py convention.
pub const SCREENING_SNIP12_VERSION: felt252 = 2;

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
struct DepositorValidation {
    depositor: ContractAddress,
    issued_at: u64,
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
    let message_hash = compute_screening_message_hash(
        :depositor, issued_at: attestation.issued_at, signer: signer_public_key,
    );
    let (r, s) = attestation.signature;
    check_ecdsa_signature(message_hash, signer_public_key, r, s)
}

/// SNIP-12 off-chain message hash envelope:
/// `poseidon('StarkNet Message', hash(domain), signer, struct_hash)`, the domain bound to the
/// current chain (revision 1). `signer` is the identity the envelope binds (e.g. account address).
fn snip12_message_hash(
    name: felt252, version: felt252, signer: felt252, struct_hash: felt252,
) -> felt252 {
    let domain = StarknetDomain {
        name, version, chain_id: get_tx_info().unbox().chain_id, revision: 1,
    };
    PoseidonTrait::new()
        .update_with('StarkNet Message')
        .update_with(domain.hash_struct())
        .update_with(signer)
        .update_with(struct_hash)
        .finalize()
}

/// SNIP-12 off-chain message hash for the `DepositorValidation { depositor, issued_at }` typed
/// message.
///
/// `signer` is the trusted signer's STARK-curve public key (felt252). Exposed so off-chain tooling
/// (TS/Python reference signers, test-vector generators) can derive the exact hash the verifier
/// will check against.
pub(crate) fn compute_screening_message_hash(
    depositor: ContractAddress, issued_at: u64, signer: felt252,
) -> felt252 {
    let validation = DepositorValidation { depositor, issued_at };
    snip12_message_hash(
        SCREENING_SNIP12_NAME, SCREENING_SNIP12_VERSION, signer, validation.hash_struct(),
    )
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
// `AdditionalData` carries opaque extra data (e.g. a nonce) bound into the signed message.
// The privacy pool passes it empty.
const CALL_SET_TYPE_HASH: felt252 = selector!(
    "\"CallSet\"(\"Calls\":\"Call*\",\"AdditionalData\":\"felt*\")\"Call\"(\"To\":\"ContractAddress\",\"Selector\":\"selector\",\"Calldata\":\"felt*\")",
);

#[derive(Drop)]
pub(crate) struct CallSet {
    pub(crate) calls: Span<Call>,
    pub(crate) additional_data: Span<felt252>,
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
            .update_with(poseidon_hash_span(*self.additional_data))
            .finalize()
    }
}

/// SNIP-12 off-chain message hash for a `CallSet` authorized by `signer` (the depositor account
/// address — the SNIP-12 envelope binds the signing account, matching starknet.js
/// `typedData.getMessageHash(td, accountAddress)`). The off-chain golden oracle for the SDK.
/// `additional_data` is opaque extra data bound into the message (empty for the pool's own path).
pub(crate) fn compute_call_set_hash(
    signer: ContractAddress, calls: Span<Call>, additional_data: Span<felt252>,
) -> felt252 {
    snip12_message_hash(
        CALL_SET_SNIP12_NAME,
        CALL_SET_SNIP12_VERSION,
        signer.into(),
        CallSet { calls, additional_data }.hash_struct(),
    )
}
