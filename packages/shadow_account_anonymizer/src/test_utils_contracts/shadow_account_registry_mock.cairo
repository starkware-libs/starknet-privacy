//! Mirrors the anonymizer's shadow account registry on both sides of the `sub_accounts` →
//! `shadow_accounts` rename, so the migration EIC can be run against a seeded pre-rename registry.
//! The storage variable names are load-bearing: the EIC addresses them by name.

use starknet::{ClassHash, ContractAddress};
use crate::shadow_account_anonymizer::IdentityCommitment;

#[starknet::interface]
pub trait IShadowAccountRegistryMock<T> {
    /// Writes an entry into the pre-rename `sub_accounts` registry.
    fn set_sub_account(
        ref self: T, identity_commitment: IdentityCommitment, sub_account: ContractAddress,
    );

    /// Returns every `sub_accounts` entry, in key insertion order.
    fn get_sub_accounts(ref self: T) -> Span<(IdentityCommitment, ContractAddress)>;

    /// Returns every `shadow_accounts` entry, in key insertion order.
    fn get_shadow_accounts(ref self: T) -> Span<(IdentityCommitment, ContractAddress)>;

    /// Runs `eic_initialize` of `eic_class_hash` against this contract's storage, the way the
    /// replaceability component does during `replace_to`.
    fn run_eic(ref self: T, eic_class_hash: ClassHash, eic_init_data: Span<felt252>);
}

#[starknet::contract]
pub mod ShadowAccountRegistryMock {
    use starknet::ClassHash;
    use starkware_utils::components::replaceability::interface::{
        IEICInitializableDispatcherTrait, IEICInitializableLibraryDispatcher,
    };
    use starkware_utils::storage::iterable_map::{
        IterableMap, IterableMapIntoIterImpl, IterableMapWriteAccessImpl,
    };
    use crate::shadow_account_anonymizer::IdentityCommitment;
    use super::{ContractAddress, IShadowAccountRegistryMock};

    #[storage]
    struct Storage {
        sub_accounts: IterableMap<IdentityCommitment, ContractAddress>,
        shadow_accounts: IterableMap<IdentityCommitment, ContractAddress>,
    }

    #[abi(embed_v0)]
    impl ShadowAccountRegistryMockImpl of IShadowAccountRegistryMock<ContractState> {
        fn set_sub_account(
            ref self: ContractState,
            identity_commitment: IdentityCommitment,
            sub_account: ContractAddress,
        ) {
            self.sub_accounts.write(identity_commitment, sub_account);
        }

        fn get_sub_accounts(
            ref self: ContractState,
        ) -> Span<(IdentityCommitment, ContractAddress)> {
            let mut entries = array![];
            for entry in self.sub_accounts {
                entries.append(entry);
            }
            entries.span()
        }

        fn get_shadow_accounts(
            ref self: ContractState,
        ) -> Span<(IdentityCommitment, ContractAddress)> {
            let mut entries = array![];
            for entry in self.shadow_accounts {
                entries.append(entry);
            }
            entries.span()
        }

        fn run_eic(
            ref self: ContractState, eic_class_hash: ClassHash, eic_init_data: Span<felt252>,
        ) {
            IEICInitializableLibraryDispatcher { class_hash: eic_class_hash }
                .eic_initialize(eic_init_data);
        }
    }
}
