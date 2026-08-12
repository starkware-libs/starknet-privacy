//! External Initializer Contract that replaces the shadow account class hash of
//! [`ShadowAccountAnonymizer`](crate::shadow_account_anonymizer::ShadowAccountAnonymizer).
//!
//! The replaceability component library-calls `eic_initialize` from within the anonymizer during
//! `replace_to`, so the write lands in the anonymizer's storage. Shadow accounts deployed before
//! the replacement keep their code and their recorded addresses; only shadow accounts deployed
//! afterwards use the new class hash.

/// Error codes for the shadow account class hash EIC.
pub mod errors {
    pub const INVALID_INIT_DATA_LEN: felt252 = 'INVALID_INIT_DATA_LEN';
    pub const INVALID_CLASS_HASH: felt252 = 'INVALID_CLASS_HASH';
}

#[starknet::contract]
pub mod ShadowAccountClassHashEIC {
    use core::num::traits::Zero;
    use starknet::ClassHash;
    use starknet::storage::StoragePointerWriteAccess;
    use starkware_utils::components::replaceability::interface::IEICInitializable;
    use super::errors;

    /// The slice of the anonymizer's storage this EIC writes through. A storage variable's address
    /// is derived from its name, so `shadow_account_class_hash` must be named exactly as it is on
    /// [`ShadowAccountAnonymizer`](crate::shadow_account_anonymizer::ShadowAccountAnonymizer).
    #[storage]
    struct Storage {
        shadow_account_class_hash: ClassHash,
    }

    #[abi(embed_v0)]
    impl EICInitializableImpl of IEICInitializable<ContractState> {
        /// Overwrites `shadow_account_class_hash` with the single class hash carried by
        /// `eic_init_data`.
        ///
        /// #### Parameters
        /// - `eic_init_data` (`Span<felt252>`) - exactly one element: the class hash to deploy
        ///   shadow accounts with from now on.
        ///
        /// #### Reverts
        /// - [`INVALID_INIT_DATA_LEN`](errors::INVALID_INIT_DATA_LEN): Thrown if `eic_init_data`
        ///   does not hold exactly one element.
        /// - [`INVALID_CLASS_HASH`](errors::INVALID_CLASS_HASH): Thrown if the element is not a
        ///   valid class hash or is zero.
        fn eic_initialize(ref self: ContractState, eic_init_data: Span<felt252>) {
            assert(eic_init_data.len() == 1, errors::INVALID_INIT_DATA_LEN);
            let shadow_account_class_hash: ClassHash = (*eic_init_data[0])
                .try_into()
                .expect(errors::INVALID_CLASS_HASH);
            // A zero class hash would make every subsequent shadow account deployment fail.
            assert(shadow_account_class_hash.is_non_zero(), errors::INVALID_CLASS_HASH);
            self.shadow_account_class_hash.write(shadow_account_class_hash);
        }
    }
}
