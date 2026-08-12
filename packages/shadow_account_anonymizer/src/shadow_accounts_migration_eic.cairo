//! External Initializer Contract that copies the shadow account registry from the pre-rename
//! `sub_accounts` storage variable into `shadow_accounts`.
//!
//! The replaceability component library-calls `eic_initialize` from within the anonymizer during
//! `replace_to`, so both reads and writes land in the anonymizer's storage. Every entry is copied
//! verbatim, in key order; `sub_accounts` is left as it was, and entries already present under
//! `shadow_accounts` keep their recorded address, so re-running the migration adds no duplicate
//! keys.

/// Error codes for the shadow accounts migration EIC.
pub mod errors {
    pub const INVALID_INIT_DATA_LEN: felt252 = 'INVALID_INIT_DATA_LEN';
}

#[starknet::contract]
pub mod ShadowAccountsMigrationEIC {
    use starknet::ContractAddress;
    use starkware_utils::components::replaceability::interface::IEICInitializable;
    use starkware_utils::storage::iterable_map::{
        IterableMap, IterableMapIntoIterImpl, IterableMapWriteAccessImpl,
    };
    use crate::shadow_account_anonymizer::IdentityCommitment;
    use super::errors;

    /// The slice of the anonymizer's storage this EIC reads and writes through. A storage
    /// variable's address is derived from its name, so `sub_accounts` must be named exactly as it
    /// was before the rename and `shadow_accounts` exactly as it is on
    /// [`ShadowAccountAnonymizer`](crate::shadow_account_anonymizer::ShadowAccountAnonymizer);
    /// both must keep their key and value types, since those decide the layout of the entries.
    #[storage]
    struct Storage {
        sub_accounts: IterableMap<IdentityCommitment, ContractAddress>,
        shadow_accounts: IterableMap<IdentityCommitment, ContractAddress>,
    }

    #[abi(embed_v0)]
    impl EICInitializableImpl of IEICInitializable<ContractState> {
        /// Copies every `sub_accounts` entry into `shadow_accounts`.
        ///
        /// #### Parameters
        /// - `eic_init_data` (`Span<felt252>`) - must be empty; the migration takes no arguments.
        ///
        /// #### Reverts
        /// - [`INVALID_INIT_DATA_LEN`](errors::INVALID_INIT_DATA_LEN): Thrown if `eic_init_data`
        ///   is not empty.
        fn eic_initialize(ref self: ContractState, eic_init_data: Span<felt252>) {
            assert(eic_init_data.is_empty(), errors::INVALID_INIT_DATA_LEN);
            for (identity_commitment, shadow_account) in self.sub_accounts {
                self.shadow_accounts.write(identity_commitment, shadow_account);
            }
        }
    }
}
