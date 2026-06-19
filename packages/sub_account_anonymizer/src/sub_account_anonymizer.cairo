//! Sub-account anonymizer for privacy-preserving dapp interactions.
//!
//! Runs arbitrary dapp calls on behalf of the privacy contract through per-commitment
//! [`SubAccount`](starkware_utils::contracts::sub_account::SubAccount) contracts. Each commitment
//! maps to a dedicated sub-account that performs the dapp calls and holds the resulting funds; the
//! anonymizer then collects those funds into itself and approves the privacy contract to pull
//! them into open notes. Driving interactions is restricted to the configured privacy contract.

use privacy::objects::OpenNoteDeposit;
use starknet::account::Call;
use starknet::{ClassHash, ContractAddress};

/// The result of [`privacy_compute`]: a commitment that identifies a single sub-account.
pub type PrivacyComputeCommitment = felt252;

/// An open note to settle after an interaction.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNote {
    /// The identifier of the open note to deposit to.
    pub note_id: felt252,
    /// The token to deposit.
    pub token: ContractAddress,
}

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
    /// - ([`PrivacyComputeCommitment`](PrivacyComputeCommitment)) - A commitment binding to a
    /// single sub-account.
    fn privacy_compute(
        self: @T, identity_key: felt252, dapp_name: felt252, nonce: felt252,
    ) -> PrivacyComputeCommitment;

    /// Executes `calls` through the sub-account bound to `commitment` (deploying it on first
    /// use), then collects each requested open-note token from the sub-account and into this
    /// anonymizer, approving the privacy contract to pull the collected amount.
    ///
    /// #### Parameters
    /// - `commitment` ([`PrivacyComputeCommitment`](PrivacyComputeCommitment)) - identifies the
    /// sub-account; see [`privacy_compute`]. Preimage is off-chain only and unrecoverable from
    /// on-chain data.
    /// - `calls` (`Array<Call>`) - the dapp calls to run as the sub-account.
    /// - `open_notes` ([`Span<OpenNote>`](OpenNote)) - the notes to settle; for each, the balance
    ///   delta the interaction added to the sub-account's `token` is collected and recorded as a
    ///   deposit.
    ///
    /// #### Returns
    /// - ([`Span<OpenNoteDeposit>`](privacy::objects::OpenNoteDeposit)) - one deposit per open
    ///   note, for the privacy contract to apply.
    ///
    /// #### Preconditions
    /// - Caller must be the configured privacy contract.
    ///
    /// #### Reverts
    /// - [`UNAUTHORIZED_CALLER`](errors::UNAUTHORIZED_CALLER): Thrown if the caller is not the
    ///   configured privacy contract.
    /// - [`AMOUNT_OVERFLOW`](errors::AMOUNT_OVERFLOW): Thrown if the amount
    ///   collected for an open note exceeds `u128`.
    fn privacy_invoke_with_computation(
        ref self: T,
        commitment: PrivacyComputeCommitment,
        calls: Array<Call>,
        open_notes: Span<OpenNote>,
    ) -> Span<OpenNoteDeposit>;

    /// Returns the sub-account address bound to `commitment`.
    ///
    /// #### Parameters
    /// - `commitment` ([`PrivacyComputeCommitment`](PrivacyComputeCommitment)) - The commitment
    /// derived by `privacy_compute`.
    ///
    /// #### Returns
    /// - (`ContractAddress`) - The deployed sub-account address, or zero if none has been deployed
    /// for `commitment` yet.
    fn get_sub_account(self: @T, commitment: PrivacyComputeCommitment) -> ContractAddress;

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

/// Error codes for sub-account anonymizer operations.
pub mod errors {
    pub const UNAUTHORIZED_CALLER: felt252 = 'UNAUTHORIZED_CALLER';
    pub const AMOUNT_OVERFLOW: felt252 = 'AMOUNT_OVERFLOW';
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
    use super::{ISubAccountAnonymizer, OpenNote, PrivacyComputeCommitment, errors};

    /// An open note together with the sub-account's balance of its token before any interaction.
    #[derive(Copy, Drop)]
    struct OpenNotePreBalance {
        note_id: felt252,
        token: ContractAddress,
        pre_balance: u256,
    }

    #[storage]
    struct Storage {
        /// Address of the authorized privacy contract.
        privacy_contract: ContractAddress,
        /// Class hash of the `SubAccount` contract deployed per commitment.
        // TODO: Consider making this a constant.
        sub_account_class_hash: ClassHash,
        /// Maps a commitment to the sub-account deployed for it.
        sub_accounts: Map<PrivacyComputeCommitment, ContractAddress>,
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
        ) -> PrivacyComputeCommitment {
            PoseidonTrait::new().update(identity_key).update(dapp_name).update(nonce).finalize()
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState,
            commitment: PrivacyComputeCommitment,
            calls: Array<Call>,
            open_notes: Span<OpenNote>,
        ) -> Span<OpenNoteDeposit> {
            assert(
                get_caller_address() == self.privacy_contract.read(), errors::UNAUTHORIZED_CALLER,
            );
            let sub_account = self.get_or_deploy_sub_account(:commitment);
            let notes = record_pre_balances(sub_account, open_notes);
            sub_account.execute(calls);
            self.collect_open_notes(:sub_account, :notes)
        }

        fn get_sub_account(
            self: @ContractState, commitment: PrivacyComputeCommitment,
        ) -> ContractAddress {
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
            ref self: ContractState, commitment: PrivacyComputeCommitment,
        ) -> ISubAccountDispatcher {
            let existing = self.sub_accounts.read(commitment);
            if existing.is_non_zero() {
                return ISubAccountDispatcher { contract_address: existing };
            }
            let (sub_account_addr, _) = deploy_syscall(
                class_hash: self.sub_account_class_hash.read(),
                contract_address_salt: commitment,
                calldata: array![].span(),
                deploy_from_zero: false,
            )
                .unwrap_syscall();
            self.sub_accounts.write(commitment, sub_account_addr);
            ISubAccountDispatcher { contract_address: sub_account_addr }
        }

        /// Settles each note in `notes`, returning one [`OpenNoteDeposit`] per note.
        /// For each note:
        /// - calculates the balance delta the interaction added to the sub-account,
        /// - transfers that amount from the sub-account to this anonymizer, and
        /// - approves the privacy contract to pull that amount from this anonymizer.
        fn collect_open_notes(
            self: @ContractState,
            sub_account: ISubAccountDispatcher,
            notes: Span<OpenNotePreBalance>,
        ) -> Span<OpenNoteDeposit> {
            let anonymizer = get_contract_address();
            let privacy_contract = self.privacy_contract.read();
            // Transfers are collected into one batch and run through a single
            // `sub_account.execute`.
            let mut transfer_calls: Array<Call> = array![];
            let mut deposits: Array<OpenNoteDeposit> = array![];
            for note in notes {
                let OpenNotePreBalance { note_id, token, pre_balance } = *note;
                let token_contract = IERC20Dispatcher { contract_address: token };
                // Collect only what the interaction added; clamp so a decrease yields zero.
                let post_balance = token_contract.balance_of(account: sub_account.contract_address);
                let amount_to_deposit = if post_balance > pre_balance {
                    post_balance - pre_balance
                } else {
                    0
                };

                transfer_calls
                    .append(
                        build_transfer_call(
                            :token, recipient: anonymizer, amount: amount_to_deposit,
                        ),
                    );
                token_contract.approve(spender: privacy_contract, amount: amount_to_deposit);
                let amount: u128 = amount_to_deposit.try_into().expect(errors::AMOUNT_OVERFLOW);
                deposits.append(OpenNoteDeposit { note_id, token, amount });
            }
            sub_account.execute(transfer_calls);
            deposits.span()
        }
    }

    /// Records pre-balance of all relevant tokens (as given in the list of open notes),
    /// to allow filling the open-notes with the correct tokens' balance delta upon execution.
    fn record_pre_balances(
        sub_account: ISubAccountDispatcher, open_notes: Span<OpenNote>,
    ) -> Span<OpenNotePreBalance> {
        let mut notes: Array<OpenNotePreBalance> = array![];
        for note in open_notes {
            let OpenNote { note_id, token } = *note;
            let pre_balance = IERC20Dispatcher { contract_address: token }
                .balance_of(account: sub_account.contract_address);
            notes.append(OpenNotePreBalance { note_id, token, pre_balance });
        }
        notes.span()
    }

    /// Builds a `Call` that transfers `amount` of `token` to `recipient`.
    fn build_transfer_call(
        token: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> Call {
        Call {
            to: token,
            selector: selector!("transfer"),
            calldata: array![recipient.into(), amount.low.into(), amount.high.into()].span(),
        }
    }
}
