/// A mock depositor account that advertises the custom-signature-validation interface (SRC5) and
/// answers `is_custom_signature_valid` with a constructor-configured verdict. Used to exercise the
/// pool's custom-validation path (`assert_valid_signature`).
///
/// `is_valid_signature` verifies a STARK-curve signature against the constructor `public_key`
/// (like a real SNIP-6 account), or — when `public_key` is 0 — always returns 0. The latter
/// makes any fallback from a failed custom validation to the raw-hash path observable in tests.
#[starknet::contract]
pub mod MockCustomAccount {
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::Zero;
    use openzeppelin::interfaces::introspection::ISRC5;
    use privacy::utils::{IAccount, ICUSTOM_SIGNATURE_VALIDATION_ID, ICustomSignatureValidation};
    use starknet::VALIDATED;
    use starknet::account::Call;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        // Felt the custom EP returns: `VALIDATED` when the configured verdict is "valid", else 0.
        custom_result: felt252,
        // Key that `is_valid_signature` verifies against; 0 disables the raw-hash path.
        public_key: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, is_valid: bool, public_key: felt252) {
        if is_valid {
            self.custom_result.write(VALIDATED);
        } else {
            self.custom_result.write(Zero::zero());
        }
        self.public_key.write(public_key);
    }

    #[abi(embed_v0)]
    impl SRC5Impl of ISRC5<ContractState> {
        fn supports_interface(self: @ContractState, interface_id: felt252) -> bool {
            interface_id == ICUSTOM_SIGNATURE_VALIDATION_ID
        }
    }

    #[abi(embed_v0)]
    impl CustomSignatureValidationImpl of ICustomSignatureValidation<ContractState> {
        fn is_custom_signature_valid(
            self: @ContractState, calls: Span<Call>, signature: Span<felt252>,
        ) -> felt252 {
            self.custom_result.read()
        }
    }

    /// Raw-hash signature path: verifies a STARK-curve signature against `public_key`, or rejects
    /// (returns 0) when `public_key` is 0.
    #[abi(embed_v0)]
    impl AccountImpl of IAccount<ContractState> {
        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            let public_key = self.public_key.read();
            if public_key.is_zero() || signature.len() != 2 {
                return Zero::zero();
            }
            if check_ecdsa_signature(hash, public_key, *signature[0], *signature[1]) {
                VALIDATED
            } else {
                Zero::zero()
            }
        }
    }
}
