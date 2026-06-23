//! Sub-account anonymizer for privacy-preserving dapp interactions.

use starknet::{ClassHash, ContractAddress};

#[starknet::interface]
pub trait ISubAccountAnonymizer<T> {
    /// Derives the commitment that identifies a sub-account.
    ///
    /// #### Parameters
    /// - `identity_key` (`felt252`) - A unique handle derived by the privacy pool from a user
    /// identity. It is linked to the user but cannot be traced back to them. Only the holder of the
    /// underlying identity can reproduce it, making it a pseudonymous proof of ownership without
    /// revealing who they are.
    /// - `dapp_name` (`felt252`) - The dapp the sub-account interacts with, scoping commitments per
    /// dapp.
    /// - `nonce` (`felt252`) - A nonce that lets one identity derive multiple distinct sub-accounts
    /// for the same dapp.
    ///
    /// #### Returns
    /// - (`felt252`) - A commitment binding to a single sub-account.
    fn privacy_compute(
        self: @T, identity_key: felt252, dapp_name: felt252, nonce: felt252,
    ) -> felt252;

    /// Returns the sub-account address bound to `commitment`.
    ///
    /// #### Parameters
    /// - `commitment` (`felt252`) - The commitment derived by `privacy_compute`.
    ///
    /// #### Returns
    /// - (`ContractAddress`) - The deployed sub-account address, or zero if none has been deployed
    /// for `commitment` yet.
    fn get_sub_account(self: @T, commitment: felt252) -> ContractAddress;

    /// Returns the privacy contract authorized to drive interactions.
    ///
    /// #### Returns
    /// - (`ContractAddress`) - The address of the authorized privacy contract.
    fn get_privacy_contract(self: @T) -> ContractAddress;

    /// Returns the class hash of the `SubAccount` contract deployed per commitment.
    ///
    /// #### Returns
    /// - (`ClassHash`) - The class hash used when deploying a sub-account.
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
            self: @ContractState, identity_key: felt252, dapp_name: felt252, nonce: felt252,
        ) -> felt252 {
            PoseidonTrait::new().update(identity_key).update(dapp_name).update(nonce).finalize()
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
