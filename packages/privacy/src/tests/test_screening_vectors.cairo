use snforge_std::{start_cheat_chain_id, test_address};
use crate::snip12::{DepositorValidation, compute_message_hash, verify_depositor_validation};
use super::screening_vectors::screening_vectors;

// Places verification inside the valid window so this isolates the hash and
// signature checks; the timing arms are covered by the verifier's own tests.
const MAX_AGE: u64 = 300;

/// The committed vectors are produced by the reference screening signer. Each is
/// signed under a specific chain_id (carried in the SNIP-12 domain), so the
/// chain_id is cheated per vector before recomputing the hash. The `assert_eq!`
/// on the recomputed message hash is the cross-language agreement check — the
/// off-chain signer produced `message_hash`, this verifier reproduces it — so it
/// is not a self-generated round-trip. Accepting the signature additionally
/// exercises STARK-curve ECDSA interop (off-chain RFC6979 sign, on-chain
/// `check_ecdsa_signature`) and the timing guards.
#[test]
fn test_committed_screening_vectors_validate() {
    for vector in screening_vectors() {
        start_cheat_chain_id(test_address(), vector.chain_id);
        let validation = DepositorValidation {
            depositor: vector.depositor.try_into().unwrap(), issued_at: vector.issued_at,
        };
        assert_eq!(
            compute_message_hash(@validation, vector.signer_public_key), vector.message_hash,
        );
        verify_depositor_validation(
            validation,
            (vector.sig_r, vector.sig_s),
            vector.signer_public_key,
            vector.issued_at,
            MAX_AGE,
        )
            .unwrap();
    }
}
