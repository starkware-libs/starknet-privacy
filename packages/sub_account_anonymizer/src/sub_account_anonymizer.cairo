//! Sub-account anonymizer for privacy-preserving dapp interactions.
//!
//! Runs arbitrary dapp calls on behalf of the privacy contract through per-commitment
//! [`SubAccount`](starkware_utils::contracts::sub_account::SubAccount) contracts. Each commitment
//! maps to a dedicated sub-account that performs the dapp calls and holds the resulting funds; the
//! anonymizer then sweeps those funds back into itself and approves the privacy contract to pull
//! them into open notes. Driving interactions is restricted to the configured privacy contract.

use privacy::objects::OpenNoteDeposit;
use starknet::account::Call;
use starknet::{ClassHash, ContractAddress};

#[starknet::interface]
pub trait ISubAccountAnonymizer<T> {
    /// Derives the commitment identifying the sub-account for a `(identity_key, dapp_name, seq_nonce)`
    /// triple. The commitment is the Poseidon hash of the three inputs.
    fn privacy_compute(
        self: @T, identity_key: felt252, dapp_name: felt252, seq_nonce: felt252,
    ) -> felt252;

    /// Executes `invokes` through the sub-account bound to `commitment` (deploying it on first
    /// use), then sweeps each requested open-note token out of the sub-account and into this
    /// anonymizer, approving the privacy contract to pull the swept amount.
    ///
    /// #### Parameters
    /// - `commitment` (`felt252`) - identifies the sub-account; see [`privacy_compute`].
    /// - `invokes` (`Span<Call>`) - the dapp calls to run as the sub-account.
    /// - `open_notes` (`Span<(felt252, ContractAddress)>`) - `(note_id, token)` pairs to settle;
    ///   for each, the sub-account's full `token` balance is swept and recorded as a deposit.
    ///
    /// #### Returns
    /// - ([`Span<OpenNoteDeposit>`](privacy::objects::OpenNoteDeposit)) - one deposit per open
    /// note,
    ///   for the privacy contract to apply.
    ///
    /// #### Preconditions
    /// - Caller must be the configured privacy contract.
    fn privacy_invoke_with_computation(
        ref self: T,
        commitment: felt252,
        invokes: Span<Call>,
        open_notes: Span<(felt252, ContractAddress)>,
    ) -> Span<OpenNoteDeposit>;

    /// Returns the sub-account address bound to `commitment`, or zero if none has been deployed
    /// yet.
    fn get_sub_account(self: @T, commitment: felt252) -> ContractAddress;

    /// Returns the privacy contract authorized to drive interactions.
    fn get_privacy_contract(self: @T) -> ContractAddress;

    /// Returns the class hash of the `SubAccount` contract deployed per commitment.
    fn get_sub_account_class_hash(self: @T) -> ClassHash;
}

/// Error codes for sub-account anonymizer operations.
pub mod errors {
    pub const CALLER_NOT_PRIVACY: felt252 = 'CALLER_NOT_PRIVACY';
    pub const SWEPT_AMOUNT_OVERFLOW: felt252 = 'SWEPT_AMOUNT_OVERFLOW';
}

#[starknet::contract]
pub mod SubAccountAnonymizer {
    use core::hash::HashStateTrait;
    use core::num::traits::Zero;
    use core::poseidon::PoseidonTrait;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::account::Call;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::deploy_syscall;
    use starknet::{
        ClassHash, ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address,
    };
    use starkware_utils::contracts::sub_account::{
        ISubAccountDispatcher, ISubAccountDispatcherTrait,
    };
    use super::{ISubAccountAnonymizer, errors};

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

        fn privacy_invoke_with_computation(
            ref self: ContractState,
            commitment: felt252,
            invokes: Span<Call>,
            open_notes: Span<(felt252, ContractAddress)>,
        ) -> Span<OpenNoteDeposit> {
            assert(
                get_caller_address() == self.privacy_contract.read(), errors::CALLER_NOT_PRIVACY,
            );

            let sub_account = self.get_or_deploy_sub_account(:commitment);

            // Run the dapp interaction as the sub-account (`Call` is not `Copy`, so rebuild each).
            let mut calls: Array<Call> = array![];
            for call in invokes {
                calls
                    .append(
                        Call { to: *call.to, selector: *call.selector, calldata: *call.calldata },
                    );
            }
            sub_account.execute(calls);

            // Sweep each open-note token out of the sub-account, then approve the privacy contract.
            let anonymizer = get_contract_address();
            let privacy_contract = self.privacy_contract.read();
            let mut deposits: Array<OpenNoteDeposit> = array![];
            for note in open_notes {
                let (note_id, token) = *note;
                let erc20 = IERC20Dispatcher { contract_address: token };
                let amount = erc20.balance_of(account: sub_account.contract_address);

                // Only the sub-account can move its own funds, so route the transfer through it.
                let transfer_calldata = array![
                    anonymizer.into(), amount.low.into(), amount.high.into(),
                ];
                sub_account
                    .execute(
                        array![
                            Call {
                                to: token,
                                selector: selector!("transfer"),
                                calldata: transfer_calldata.span(),
                            },
                        ],
                    );

                erc20.approve(spender: privacy_contract, amount: amount);
                let amount: u128 = amount.try_into().expect(errors::SWEPT_AMOUNT_OVERFLOW);
                deposits.append(OpenNoteDeposit { note_id, token, amount });
            }
            deposits.span()
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

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Returns the sub-account bound to `commitment`, deploying a fresh one on first use. The
        /// commitment is the deployment salt, so each commitment maps to a deterministic address,
        /// and the deployed `SubAccount` records this anonymizer (its deployer) as owner.
        fn get_or_deploy_sub_account(
            ref self: ContractState, commitment: felt252,
        ) -> ISubAccountDispatcher {
            let existing = self.sub_accounts.read(commitment);
            if existing.is_non_zero() {
                return ISubAccountDispatcher { contract_address: existing };
            }
            let (sub_account_addr, _) = deploy_syscall(
                self.sub_account_class_hash.read(), commitment, array![].span(), false,
            )
                .unwrap_syscall();
            self.sub_accounts.write(commitment, sub_account_addr);
            ISubAccountDispatcher { contract_address: sub_account_addr }
        }
    }
}
