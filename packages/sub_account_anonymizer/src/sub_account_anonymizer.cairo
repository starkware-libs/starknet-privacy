//! Sub-account anonymizer for privacy-preserving dapp interactions.

use starknet::{ClassHash, ContractAddress};

#[starknet::interface]
pub trait ISubAccountAnonymizer<T> {
    /// Derives the commitment identifying the sub-account for a `(identity_key, dapp_name, seq_nonce)`
    /// triple. The commitment is the Poseidon hash of the three inputs.
    fn privacy_compute(
        self: @T, identity_key: felt252, dapp_name: felt252, seq_nonce: felt252,
    ) -> felt252;

    /// Returns the sub-account address bound to `commitment`, or zero if none has been deployed
    /// yet.
    fn get_sub_account(self: @T, commitment: felt252) -> ContractAddress;

    /// Returns the privacy contract authorized to drive interactions.
    fn get_privacy_contract(self: @T) -> ContractAddress;

    /// Returns the class hash of the `SubAccount` contract deployed per commitment.
    fn get_sub_account_class_hash(self: @T) -> ClassHash;
}

#[starknet::contract]
pub mod SubAccountAnonymizer {
    use core::hash::HashStateTrait;
    use core::poseidon::PoseidonTrait;
    use starknet::storage::{
        Map, StorageMapReadAccess, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ClassHash, ContractAddress};
    use super::ISubAccountAnonymizer;

    #[storage]
    struct Storage {
        /// Address of the authorized privacy contract.
        privacy_contract: ContractAddress,
        /// Class hash of the `SubAccount` contract deployed per commitment.
        // TODO: Consider making this a constant.
        sub_account_class_hash: ClassHash,
        /// Maps a commitment to the sub-account deployed for it.
        sub_accounts: Map<felt252, ContractAddress>,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_contract: ContractAddress,
        sub_account_class_hash: ClassHash,
    ) {
        self.privacy_contract.write(privacy_contract);
        self.sub_account_class_hash.write(sub_account_class_hash);
    }

    #[abi(embed_v0)]
    pub impl SubAccountAnonymizerImpl of ISubAccountAnonymizer<ContractState> {
        fn privacy_compute(
            self: @ContractState, identity_key: felt252, dapp_name: felt252, seq_nonce: felt252,
        ) -> felt252 {
            PoseidonTrait::new().update(identity_key).update(dapp_name).update(seq_nonce).finalize()
        }

        fn get_sub_account(self: @ContractState, commitment: felt252) -> ContractAddress {
            self.sub_accounts.read(commitment)
        }

        fn get_privacy_contract(self: @ContractState) -> ContractAddress {
            self.privacy_contract.read()
        }

        fn get_sub_account_class_hash(self: @ContractState) -> ClassHash {
            self.sub_account_class_hash.read()
        }
    }
}
