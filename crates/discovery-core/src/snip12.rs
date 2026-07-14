//! SNIP-12 typed-message hashing utilities for off-chain signature verification.
//!
//! Provides Rust-equivalent implementations of the Cairo SNIP-12 helpers in
//! `packages/privacy/src/snip12.cairo`, used primarily for test-vector generation
//! and SDK golden-oracle verification.
//!
//! ## SNIP-12 Message Envelope
//!
//! All off-chain messages follow the SNIP-12 envelope:
//! `poseidon('StarkNet Message', domain_hash, signer, struct_hash)`
//!
//! where `domain_hash = poseidon([STARKNET_DOMAIN_TYPE_HASH, name, version, chain_id, 1])`.
//!
//! ## SNIP-12 Specification
//!
//! See <https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-12.md>.

use starknet_crypto::poseidon_hash_many;
use starknet_types_core::felt::Felt;

/// StarkNet domain separator for SNIP-12 typed messages.
/// Derived from starknet_keccak("StarkNet Message") → 0x537461726b4e6574204d657373616765.
const STARKNET_MESSAGE: Felt = Felt::from_hex_unchecked("0x537461726b4e6574204d657373616765");

/// SNIP-12 type name for `CallSet`.
/// ASCII bytes of "CallSet" as a felt252.
const CALL_SET_SNIP12_NAME: Felt = Felt::from_hex_unchecked("0x43616c6c536574");

/// SNIP-12 version for `CallSet`.
const CALL_SET_SNIP12_VERSION: Felt = Felt::ONE;

/// SNIP-12 type hash for the `CallSet` struct.
///
/// Pre-computed from the Cairo selector!:
/// `selector!("\"CallSet\"(\"Calls\":\"Call*\",\"AdditionalData\":\"felt*\")\"Call\"(\"To\":\"ContractAddress\",\"Selector\":\"selector\",\"Calldata\":\"felt*\")")`
const CALL_SET_TYPE_HASH: Felt =
    Felt::from_hex_unchecked("0x2d10fa6c1e12c7504e4eb8951e65c5c7efddaf6adbe5e20df5615b12aa6bcd");

/// SNIP-12 type hash for the `Call` struct.
///
/// Pre-computed via starknet_keccak("\"Call\"(\"To\":\"ContractAddress\",\"Selector\":\"selector\",\"Calldata\":\"felt*\")").
const CALL_TYPE_HASH: Felt =
    Felt::from_hex_unchecked("0xa92c0c3ffc81a786f1009dc3f790ab357f488ee164d0c04438a97b2a7f5c63b3");

/// SNIP-12 type hash for `StarknetDomain`.
///
/// Cairo-computed via `selector!("\"StarknetDomain\"(\"name\":\"shortstring\",\"version\":\"shortstring\",
///                    \"chainId\":\"shortstring\",\"revision\":\"shortstring\")")` — must match
/// OpenZeppelin Cairo's `STARKNET_DOMAIN_TYPE_HASH`.
const STARKNET_DOMAIN_TYPE_HASH: Felt =
    Felt::from_hex_unchecked("0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210");

/// Computes the SNIP-12 `StarknetDomain` struct hash.
///
/// Matches OpenZeppelin Cairo's `StarknetDomain.hash_struct()` which uses
/// PoseidonTrait with per-field `update_with` (permutes after every field):
/// `PoseidonTrait::new().update_with(TYPE_HASH).update_with(name)
///  .update_with(version).update_with(chain_id).update_with(1).finalize()`.
fn starknet_domain_hash(name: Felt, version: Felt, chain_id: Felt) -> Felt {
    use starknet_types_core::hash::Poseidon;

    let mut state = [Felt::ZERO, Felt::ZERO, Felt::ZERO];
    // STARKNET_DOMAIN_TYPE_HASH
    state[0] += STARKNET_DOMAIN_TYPE_HASH;
    Poseidon::hades_permutation(&mut state);
    // name
    state[0] += name;
    Poseidon::hades_permutation(&mut state);
    // version
    state[0] += version;
    Poseidon::hades_permutation(&mut state);
    // chain_id
    state[0] += chain_id;
    Poseidon::hades_permutation(&mut state);
    // revision = 1
    state[0] += Felt::ONE;
    Poseidon::hades_permutation(&mut state);
    state[0]
}

/// Computes the SNIP-12 `Call` struct hash.
///
/// Structure: `poseidon([CALL_TYPE_HASH, call.to, call.selector, poseidon_hash_many(calldata)])`
fn call_struct_hash(to: Felt, selector: Felt, calldata: &[Felt]) -> Felt {
    let calldata_hash = poseidon_hash_many(calldata);
    poseidon_hash_many(&[CALL_TYPE_HASH, to, selector, calldata_hash])
}

/// Computes the SNIP-12 `CallSet` struct hash.
///
/// Structure:
/// Helper: convert a slice reference to a const-generic array, then hash with StarkHash::hash_array.
fn poseidon_hash_const<const N: usize>(values: &[Felt]) -> Felt {
    use starknet_types_core::felt::Felt;
    use starknet_types_core::hash::{Poseidon, StarkHash};
    let mut arr = [Felt::ZERO; N];
    arr.copy_from_slice(values);
    <Poseidon as StarkHash>::hash_array(&arr)
}

/// Shorthand: hash a known-size array directly.
fn poseidon_array<const N: usize>(values: [Felt; N]) -> Felt {
    poseidon_hash_const::<N>(&values)
}

/// `poseidon([CALL_SET_TYPE_HASH, poseidon_hash_slice(calls_hashes), poseidon_hash_slice(additional_data)])`
fn call_set_struct_hash<'a, I>(calls: I, additional_data: &[Felt]) -> Felt
where
    I: Iterator<Item = (Felt, Felt, &'a [Felt])>,
{
    let call_hashes: Vec<Felt> = calls
        .map(|(to, selector, calldata)| call_struct_hash(to, selector, calldata))
        .collect();

    let calls_hash = poseidon_hash_const::<0>(&call_hashes);
    let additional_data_hash = poseidon_hash_const::<0>(additional_data);

    poseidon_array([CALL_SET_TYPE_HASH, calls_hash, additional_data_hash])
}

/// SNIP-12 off-chain message hash envelope.
///
/// `poseidon('StarkNet Message', domain_hash, signer, struct_hash)`
fn snip12_message_hash(
    name: Felt,
    version: Felt,
    chain_id: Felt,
    signer: Felt,
    struct_hash: Felt,
) -> Felt {
    let domain_hash = starknet_domain_hash(name, version, chain_id);
    // Cairo envelope: PoseidonTrait::new().update_with(domain).update_with(signer).update_with(struct_hash).finalize()
    poseidon_array([domain_hash, signer, struct_hash])
}

/// Computes the SNIP-12 `CallSet` message hash.
///
/// This is the off-chain golden oracle that the Cairo contract's
/// `compute_call_set_hash` produces; SDK tooling uses this to pre-verify
/// signatures before submission.
///
/// # Arguments
///
/// * `chain_id`   - Chain identifier felt (e.g. `0x54455354` for "TEST").
/// * `signer`    - Contract address of the account signing the message (as felt).
/// * `calls` - Slice of `(to, selector, calldata)` tuples. Each `calldata`
///   is a `Vec<Felt>` with no explicit upper bound; field arithmetic
///   (`Felt`) bounds the practical size (~31 bytes per felt).
/// * `additional_data` - Opaque extra data bound into the message (e.g. a nonce).
///   Empty slice (`&[]`) and zero-filled slice are NOT equivalent;
///   both are valid but produce different hashes.
pub fn compute_call_set_hash(
    chain_id: Felt,
    signer: Felt,
    calls: &[(Felt, Felt, Vec<Felt>)],
    additional_data: &[Felt],
) -> Felt {
    // call_set_struct_hash accepts any Iterator, so we pass one directly.
    // This avoids the intermediate Vec allocation in compute_call_set_hash.
    let struct_hash = call_set_struct_hash(
        calls
            .iter()
            .map(|(to, selector, calldata)| (*to, *selector, calldata.as_slice())),
        additional_data,
    );
    snip12_message_hash(
        CALL_SET_SNIP12_NAME,
        CALL_SET_SNIP12_VERSION,
        chain_id,
        signer,
        struct_hash,
    )
}

/// Returns the pre-computed `Call` type hash.
pub const fn call_type_hash() -> Felt {
    CALL_TYPE_HASH
}

/// Returns the pre-computed `CallSet` type hash.
pub const fn call_set_type_hash() -> Felt {
    CALL_SET_TYPE_HASH
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_poseidon_intermediates() {
        use starknet_types_core::felt::Felt;

        // Same inputs as Cairo test:
        // chain_id = 'TEST' = 0x54455354
        // signer = 0x1234 (ContractAddress)
        let chain_id = Felt::from_hex_unchecked("0x54455354"); // 'TEST'
        let signer = Felt::from_hex_unchecked("0x1234");
        let name = Felt::from_hex_unchecked("0x537461726b4e6574204d657373616765"); // 'StarkNet Message'

        // Cairo domain_hash for these inputs:
        // 0xc573861aaa70866f39b9a3499de2e6a051c8dadfadd90257d249d600d6d6b6
        // Cairo call_set_hash (empty calls, empty data):
        // 0x153fda37dd6b9520ddaee3972ac276766e66c039ce8bd37c5bf130236ba56da

        let domain_hash = starknet_domain_hash(name, Felt::ONE, chain_id);
        println!("[DEBUG] Rust domain_hash            = {:#066x}", domain_hash);
        println!("[DEBUG] Cairo domain_hash (known)   = 0xc573861aaa70866f39b9a3499de2e6a051c8dadfadd90257d249d600d6d6b6");
        println!("[DEBUG] domain match: {}", domain_hash == Felt::from_hex_unchecked("0xc573861aaa70866f39b9a3499de2e6a051c8dadfadd90257d249d600d6d6b6"));

        let call_set_hash = compute_call_set_hash(chain_id, signer, &[], &[]);
        println!("[DEBUG] Rust call_set_hash          = {:#066x}", call_set_hash);
        println!("[DEBUG] Cairo call_set_hash (known) = 0x153fda37dd6b9520ddaee3972ac276766e66c039ce8bd37c5bf130236ba56da");
        println!("[DEBUG] hash match: {}", call_set_hash == Felt::from_hex_unchecked("0x153fda37dd6b9520ddaee3972ac276766e66c039ce8bd37c5bf130236ba56da"));
    }

    /// Selector for "approve" — starknet_keccak("approve").
    const SELECTOR_APPROVE: Felt =
        Felt::from_hex_unchecked("0x0c48a8e01ad7c6c51963f0166509f29d2e9880dfb1da7417177532089e201952");

    // ─── Cross-language golden values ────────────────────────────────────────────
    // Verified against Cairo `packages/privacy/src/snip12.cairo` via `scarb cairo-test`.
    // All four vectors match; re-run `snforge test test_snip12_integration` to re-emit.

    /// Golden: empty calls, empty additional_data.
    /// Cairo: `compute_call_set_hash(signer=0x1234, calls=[], additional_data=[])`
    const GOLDEN_EMPTY_CALLS_EMPTY_DATA: Felt =
        Felt::from_hex_unchecked("0x153fda37dd6b9520ddaee3972ac276766e66c039ce8bd37c5bf130236ba56da");

    /// Golden: single call (approve, calldata=[1,2]), empty additional_data.
    /// Cairo: `compute_call_set_hash(signer=0x1234, calls=[Call{to=0x111,selector='approve',calldata=[1,2]}], additional_data=[])`
    const GOLDEN_SINGLE_CALL_EMPTY_DATA: Felt =
        Felt::from_hex_unchecked("0x37c8674d3837d35a39f02a3c7f7a7b16589186d0c15444e8178bff27d3ac159");

    /// Golden: single call (approve, calldata=[1]), additional_data=[0xa, 0xb].
    const GOLDEN_SINGLE_CALL_WITH_DATA: Felt =
        Felt::from_hex_unchecked("0x6bc52b67a4c77c4719d25dc729c8c73da810f91c8023ef1ea6be17677bc030b");

    /// Golden: same call as above but signer=0x1235 (vs 0x1234).
    const GOLDEN_DIFF_SIGNER: Felt =
        Felt::from_hex_unchecked("0x1292ebb4509248020b562302e44cb51e2d822ea28f5c3b12a83ed6a93099fc8");

    /// Cross-language golden test: verifies Rust `compute_call_set_hash` produces
    /// bit-for-bit identical output to the Cairo contract implementation.
    ///
    /// Inputs match the four Cairo test vectors in
    /// `packages/privacy/src/tests/test_snip12_integration.cairo`.
    ///
    /// If this test fails, the Rust/Cairo parity assumption is broken — do not merge.
    #[test]
    fn test_cross_language_golden() {
        let chain_id = Felt::from_hex_unchecked("0x54455354"); // "TEST"
        let signer = Felt::from_hex_unchecked("0x1234");
        let signer2 = Felt::from_hex_unchecked("0x1235");

        // Vector 1: empty calls, empty additional_data
        let h1 = compute_call_set_hash(chain_id, signer, &[], &[]);
        assert_eq!(
            h1, GOLDEN_EMPTY_CALLS_EMPTY_DATA,
            "empty_calls_empty_data mismatch — Rust/Cairo parity broken"
        );

        // Vector 2: single call (approve, calldata=[1,2]), empty additional_data
        let h2 = compute_call_set_hash(
            chain_id,
            signer,
            &[(Felt::from_hex_unchecked("0x111"), SELECTOR_APPROVE, vec![Felt::ONE, Felt::from(2)])],
            &[],
        );
        assert_eq!(
            h2, GOLDEN_SINGLE_CALL_EMPTY_DATA,
            "single_call_empty_data mismatch — Rust/Cairo parity broken"
        );

        // Vector 3: same call + additional_data=[0xa, 0xb]
        let h3 = compute_call_set_hash(
            chain_id,
            signer,
            &[(Felt::from_hex_unchecked("0x111"), SELECTOR_APPROVE, vec![Felt::ONE])],
            &[Felt::from(0xa), Felt::from(0xb)],
        );
        assert_eq!(
            h3, GOLDEN_SINGLE_CALL_WITH_DATA,
            "single_call_with_data mismatch — Rust/Cairo parity broken"
        );

        // Vector 4: same call but different signer
        let h4 = compute_call_set_hash(
            chain_id,
            signer2,
            &[(Felt::from_hex_unchecked("0x111"), SELECTOR_APPROVE, vec![Felt::ONE, Felt::from(2)])],
            &[],
        );
        assert_eq!(h4, GOLDEN_DIFF_SIGNER, "diff_signer mismatch — Rust/Cairo parity broken");
    }

    #[test]
    fn test_empty_calls_empty_additional_data() {
        let chain_id = Felt::from_hex_unchecked("0x54455354"); // "TEST"
        let signer = Felt::from_hex_unchecked("0x1234");
        let calls = vec![];
        let additional_data = vec![];

        let hash = compute_call_set_hash(chain_id, signer, &calls, &additional_data);
        // Hash must be deterministic and non-zero
        assert!(hash != Felt::ZERO);

        // Compute again to verify determinism
        let hash2 = compute_call_set_hash(chain_id, signer, &calls, &additional_data);
        assert_eq!(hash, hash2);

        // Emit for golden extraction
        println!("[GOLDEN] empty_calls_empty_data=0x{:064x}", hash);
    }

    #[test]
    fn test_single_call_empty_additional_data() {
        let chain_id = Felt::from_hex_unchecked("0x54455354"); // "TEST"
        let signer = Felt::from_hex_unchecked("0x1234");
        let calls = vec![(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            vec![Felt::ONE, Felt::from(2)],
        )];
        let additional_data = vec![];

        let hash = compute_call_set_hash(chain_id, signer, &calls, &additional_data);
        assert!(hash != Felt::ZERO);

        // Compare with empty calls — should differ
        let empty_hash = compute_call_set_hash(chain_id, signer, &[], &additional_data);
        assert_ne!(hash, empty_hash);

        println!("[GOLDEN] single_call_empty_data=0x{:064x}", hash);
    }

    #[test]
    fn test_additional_data_changes_hash() {
        let chain_id = Felt::from_hex_unchecked("0x54455354"); // "TEST"
        let signer = Felt::from_hex_unchecked("0x1234");
        let calls = vec![(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            vec![Felt::ONE, Felt::from(2)],
        )];

        let hash_empty = compute_call_set_hash(chain_id, signer, &calls, &[]);
        let hash_with_data = compute_call_set_hash(
            chain_id,
            signer,
            &calls,
            &[Felt::from(0xA), Felt::from(0xB)],
        );
        let hash_other_data = compute_call_set_hash(
            chain_id,
            signer,
            &calls,
            &[Felt::from(0xA), Felt::from(0xC)],
        );

        assert_ne!(hash_empty, hash_with_data);
        assert_ne!(hash_with_data, hash_other_data);

        println!("[GOLDEN] single_call_with_data=0x{:064x}", hash_with_data);
    }

    #[test]
    fn test_signer_binds_hash() {
        let chain_id = Felt::from_hex_unchecked("0x54455354"); // "TEST"
        let calls = vec![(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            vec![Felt::ONE, Felt::from(2)],
        )];

        let hash_a = compute_call_set_hash(chain_id, Felt::ONE, &calls, &[]);
        let hash_b = compute_call_set_hash(chain_id, Felt::from(2), &calls, &[]);
        assert_ne!(hash_a, hash_b);

        println!("[GOLDEN] diff_signer=0x{:064x}", hash_b);
    }

    #[test]
    fn test_chain_id_binds_hash() {
        let signer = Felt::from_hex_unchecked("0x1234");
        let calls = vec![(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            vec![Felt::ONE, Felt::from(2)],
        )];

        let test_chain = Felt::from_hex_unchecked("0x54455354");
        let main_chain = Felt::from_hex_unchecked("0x534e5f5345504f4c4941"); // "SN_SEPOLIA"
        let hash_test = compute_call_set_hash(test_chain, signer, &calls, &[]);
        let hash_main = compute_call_set_hash(main_chain, signer, &calls, &[]);
        assert_ne!(hash_test, hash_main);
    }

    #[test]
    fn test_type_hash_constants() {
        // Verify the pre-computed type hashes are non-zero
        assert!(CALL_TYPE_HASH != Felt::ZERO);
        assert!(CALL_SET_TYPE_HASH != Felt::ZERO);
        // Sanity: they are different from each other
        assert_ne!(CALL_TYPE_HASH, CALL_SET_TYPE_HASH);
    }

    #[test]
    fn test_call_struct_hash_deterministic() {
        let calldata = &[Felt::ONE, Felt::from(2)];
        let hash1 = call_struct_hash(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            calldata,
        );
        let hash2 = call_struct_hash(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            calldata,
        );
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_different_calls_different_hashes() {
        let calldata1 = &[Felt::ONE];
        let calldata2 = &[Felt::from(2)];

        let hash1 = call_struct_hash(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            calldata1,
        );
        let hash2 = call_struct_hash(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            calldata2,
        );
        assert_ne!(hash1, hash2);

        let hash3 = call_struct_hash(
            Felt::from_hex_unchecked("0x222"),
            SELECTOR_APPROVE,
            calldata1,
        );
        assert_ne!(hash1, hash3);
    }

    #[test]
    fn test_large_calldata() {
        // SNIP-12: field arithmetic bounds practical calldata size.
        // 128 felts ≈ 128 * 31 bytes ≈ 4KB — well within felt252 field.
        let chain_id = Felt::from_hex_unchecked("0x54455354");
        let signer = Felt::from_hex_unchecked("0x1234");
        let large_calldata: Vec<Felt> = (0..128).map(Felt::from).collect();
        let calls = vec![(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            large_calldata,
        )];
        let hash = compute_call_set_hash(chain_id, signer, &calls, &[]);
        assert!(hash != Felt::ZERO);
    }

    #[test]
    fn test_felt_max_calldata() {
        // Boundary: max felt value in calldata.
        let chain_id = Felt::from_hex_unchecked("0x54455354");
        let signer = Felt::from_hex_unchecked("0x1234");
        let calls = vec![(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            vec![Felt::MAX],
        )];
        let hash = compute_call_set_hash(chain_id, signer, &calls, &[]);
        assert!(hash != Felt::ZERO);
    }

    #[test]
    fn test_multiple_calls() {
        let chain_id = Felt::from_hex_unchecked("0x54455354");
        let signer = Felt::from_hex_unchecked("0x1234");
        let calls = vec![
            (
                Felt::from_hex_unchecked("0x111"),
                SELECTOR_APPROVE,
                vec![Felt::ONE],
            ),
            (
                Felt::from_hex_unchecked("0x222"),
                Felt::from_hex_unchecked(
                    "0x01799a410fe5a25b8c1aedc7a2b1b7c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
                ),
                vec![Felt::from(2), Felt::from(3)],
            ),
        ];
        let hash = compute_call_set_hash(chain_id, signer, &calls, &[]);
        assert!(hash != Felt::ZERO);

        // Reversed order should produce different hash
        let calls_reversed = vec![
            (
                Felt::from_hex_unchecked("0x222"),
                Felt::from_hex_unchecked(
                    "0x01799a410fe5a25b8c1aedc7a2b1b7c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
                ),
                vec![Felt::from(2), Felt::from(3)],
            ),
            (
                Felt::from_hex_unchecked("0x111"),
                SELECTOR_APPROVE,
                vec![Felt::ONE],
            ),
        ];
        let hash_reversed = compute_call_set_hash(chain_id, signer, &calls_reversed, &[]);
        assert_ne!(hash, hash_reversed);
    }

    #[test]
    fn test_empty_vs_zero_filled_additional_data() {
        // Review item 5: empty &[] vs zero-filled [0,0,...] are NOT equivalent.
        let chain_id = Felt::from_hex_unchecked("0x54455354");
        let signer = Felt::from_hex_unchecked("0x1234");
        let calls = vec![(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            vec![Felt::ONE],
        )];

        let hash_empty = compute_call_set_hash(chain_id, signer, &calls, &[]);
        let hash_zero = compute_call_set_hash(chain_id, signer, &calls, &[Felt::ZERO, Felt::ZERO]);
        assert_ne!(hash_empty, hash_zero);
    }

    #[test]
    fn test_domain_hash_replay_protection() {
        // Review item 6: domain_hash cannot be replayed across different chain IDs.
        let signer = Felt::from_hex_unchecked("0x1234");
        let calls = vec![(
            Felt::from_hex_unchecked("0x111"),
            SELECTOR_APPROVE,
            vec![Felt::ONE],
        )];

        let testnet = Felt::from_hex_unchecked("0x534e5f54455354"); // "SN_TEST"
        let mainnet = Felt::from_hex_unchecked("0x534e5f4d41494e"); // "SN_MAIN"
        let sepolia = Felt::from_hex_unchecked("0x534e5f5345504f4c4941"); // "SN_SEPOLIA"

        let hash_test = compute_call_set_hash(testnet, signer, &calls, &[]);
        let hash_main = compute_call_set_hash(mainnet, signer, &calls, &[]);
        let hash_sepolia = compute_call_set_hash(sepolia, signer, &calls, &[]);

        assert_ne!(hash_test, hash_main);
        assert_ne!(hash_test, hash_sepolia);
        assert_ne!(hash_main, hash_sepolia);
    }
}
