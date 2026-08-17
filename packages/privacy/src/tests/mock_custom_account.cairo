/// A mock depositor account that advertises the custom-signature-validation interface (SRC5) and
/// answers `is_custom_signature_valid` with the constructor-configured `custom_result` felt. Used
/// to exercise the pool's custom-validation path (`assert_valid_signature`), including verdict
/// felts the pool must NOT treat as acceptance.
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

    pub const CUSTOM_INVALID_SIG: felt252 = 'CUSTOM_INVALID_SIG';

    #[storage]
    struct Storage {
        // Verdict felt the custom EP returns; only `VALIDATED` counts as acceptance to the pool.
        custom_result: felt252,
        // Whether the custom EP reports a non-`VALIDATED` verdict by panicking instead of
        // returning it.
        panics_on_reject: bool,
        // Key that `is_valid_signature` verifies against; 0 disables the raw-hash path.
        public_key: felt252,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        custom_result: felt252,
        panics_on_reject: bool,
        public_key: felt252,
    ) {
        self.custom_result.write(custom_result);
        self.panics_on_reject.write(panics_on_reject);
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
            self: @ContractState,
            calls: Span<Call>,
            additional_data: Span<felt252>,
            signature: Span<felt252>,
        ) -> felt252 {
            let custom_result = self.custom_result.read();
            assert(custom_result == VALIDATED || !self.panics_on_reject.read(), CUSTOM_INVALID_SIG);
            custom_result
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
