/// A mock depositor account that advertises the custom-signature-validation interface (SRC5) and
/// answers `is_custom_signature_valid` with a constructor-configured verdict. Used to exercise the
/// pool's custom-validation branch (`assert_valid_signature`).
#[starknet::contract]
pub mod MockCustomAccount {
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
    }

    #[constructor]
    fn constructor(ref self: ContractState, is_valid: bool) {
        if is_valid {
            self.custom_result.write(VALIDATED);
        } else {
            self.custom_result.write(Zero::zero());
        }
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

    /// Raw-hash signature path: always rejects, so any accidental fallback to the legacy check is
    /// visible (the custom path is the only way this account authenticates).
    #[abi(embed_v0)]
    impl AccountImpl of IAccount<ContractState> {
        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            Zero::zero()
        }
    }
}
