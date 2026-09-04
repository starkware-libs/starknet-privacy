//! Mirrors the anonymizer's shadow account registry,
//! so tests can seed entries the anonymizer has no code path to produce
//! (e.g. legacy addresses, pre-primer).
#[starknet::contract]
pub mod ShadowAccountRegistryMock {
    use starknet::ContractAddress;
    use starkware_utils::storage::iterable_map::IterableMap;
    use crate::shadow_account_anonymizer::IdentityCommitment;

    #[storage]
    pub struct Storage {
        pub shadow_accounts: IterableMap<IdentityCommitment, ContractAddress>,
    }
}
