//! Executor anonymizer for privacy-preserving dapp interactions.
//!
//! Maintains a registry of per-commitment
//! [`SubAccount`](starkware_utils::contracts::sub_account::SubAccount)
//! contracts on behalf of a single privacy contract. A commitment binds a
//! `(user_hash, dapp_name, seq_nonce)` triple to one sub-account; subsequent layers deploy
//! sub-accounts lazily and run dapp interactions through them.
//!
//! This module provides the storage layout and read accessors; the interaction entrypoints are
//! added on top.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IExecutorAnonymizer<T> {
    /// Returns the executor address bound to `commitment`, or zero if none has been deployed yet.
    fn get_executor(self: @T, commitment: felt252) -> ContractAddress;

    /// Returns the privacy contract authorized to drive interactions.
    fn get_privacy_contract(self: @T) -> ContractAddress;
}

#[starknet::contract]
pub mod ExecutorAnonymizer {
    use starknet::storage::{
        Map, StorageMapReadAccess, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ClassHash, ContractAddress};
    use super::IExecutorAnonymizer;

    #[storage]
    struct Storage {
        /// The only address allowed to drive interactions.
        privacy_contract: ContractAddress,
        /// Class hash of the `Executor` contract deployed per commitment.
        executor_class_hash: ClassHash,
        /// Maps a commitment to the executor deployed for it (zero if none yet).
        executors: Map<felt252, ContractAddress>,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, privacy_contract: ContractAddress, executor_class_hash: ClassHash,
    ) {
        self.privacy_contract.write(privacy_contract);
        self.executor_class_hash.write(executor_class_hash);
    }

    #[abi(embed_v0)]
    pub impl ExecutorAnonymizerImpl of IExecutorAnonymizer<ContractState> {
        fn get_executor(self: @ContractState, commitment: felt252) -> ContractAddress {
            self.executors.read(commitment)
        }

        fn get_privacy_contract(self: @ContractState) -> ContractAddress {
            self.privacy_contract.read()
        }
    }
}
