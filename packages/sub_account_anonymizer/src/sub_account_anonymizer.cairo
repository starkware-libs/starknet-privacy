//! Sub-account anonymizer for privacy-preserving dapp interactions.
//!
//! Runs arbitrary dapp calls on behalf of the privacy contract through per-commitment
//! [`SubAccount`](starkware_utils::contracts::sub_account::SubAccount) contracts. Each commitment
//! maps to a dedicated sub-account that performs the dapp calls and holds the resulting funds; the
//! anonymizer then collects those funds into itself and approves the privacy contract to pull
//! them into open notes. Driving interactions is restricted to the configured privacy contract,
//! while upgrading the contract class is restricted to the owner.

use privacy::objects::OpenNoteDeposit;
use starknet::account::Call;
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

    /// Executes `invokes` through the sub-account bound to `commitment` (deploying it on first
    /// use), then collects each requested open-note token from the sub-account and into this
    /// anonymizer, approving the privacy contract to pull the collected amount.
    ///
    /// #### Parameters
    /// - `commitment` (`felt252`) - identifies the sub-account; see [`privacy_compute`].
    /// - `invokes` (`Array<Call>`) - the dapp calls to run as the sub-account.
    /// - `open_notes` (`Span<(felt252, ContractAddress)>`) - `(note_id, token)` pairs to settle;
    ///   for each, the amount the interaction added to the sub-account's `token` balance is
    ///   collected and recorded as a deposit.
    ///
    /// #### Returns
    /// - ([`Span<OpenNoteDeposit>`](privacy::objects::OpenNoteDeposit)) - one deposit per open
    ///   note, for the privacy contract to apply.
    ///
    /// #### Preconditions
    /// - Caller must be the configured privacy contract.
    ///
    /// #### Reverts
    /// - [`CALLER_NOT_PRIVACY`](errors::CALLER_NOT_PRIVACY): Thrown if the caller is not the
    ///   configured privacy contract.
    /// - [`COLLECTED_AMOUNT_OVERFLOW`](errors::COLLECTED_AMOUNT_OVERFLOW): Thrown if the amount
    ///   collected for an open note exceeds `u128`.
    fn privacy_invoke_with_computation(
        ref self: T,
        commitment: felt252,
        invokes: Array<Call>,
        open_notes: Span<(felt252, ContractAddress)>,
    ) -> Span<OpenNoteDeposit>;

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

/// Error codes for sub-account anonymizer operations.
pub mod errors {
    pub const CALLER_NOT_PRIVACY: felt252 = 'CALLER_NOT_PRIVACY';
    pub const COLLECTED_AMOUNT_OVERFLOW: felt252 = 'COLLECTED_AMOUNT_OVERFLOW';
}

#[starknet::contract]
pub mod SubAccountAnonymizer {
    use core::hash::HashStateTrait;
    use core::num::traits::Zero;
    use core::poseidon::PoseidonTrait;
    use openzeppelin::access::ownable::OwnableComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::interfaces::upgrades::IUpgradeable;
    use openzeppelin::upgrades::UpgradeableComponent;
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

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        /// Address of the authorized privacy contract.
        privacy_contract: ContractAddress,
        /// Class hash of the `SubAccount` contract deployed per commitment.
        // TODO: Consider making this a constant.
        sub_account_class_hash: ClassHash,
        /// Maps a commitment to the sub-account deployed for it.
        sub_accounts: Map<felt252, ContractAddress>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_contract: ContractAddress,
        sub_account_class_hash: ClassHash,
        owner: ContractAddress,
    ) {
        self.privacy_contract.write(privacy_contract);
        self.sub_account_class_hash.write(sub_account_class_hash);
        self.ownable.initializer(owner);
    }

    #[abi(embed_v0)]
    pub impl SubAccountAnonymizerImpl of ISubAccountAnonymizer<ContractState> {
        fn privacy_compute(
            self: @ContractState, identity_key: felt252, dapp_name: felt252, nonce: felt252,
        ) -> felt252 {
            PoseidonTrait::new().update(identity_key).update(dapp_name).update(nonce).finalize()
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState,
            commitment: felt252,
            invokes: Array<Call>,
            open_notes: Span<(felt252, ContractAddress)>,
        ) -> Span<OpenNoteDeposit> {
            assert(
                get_caller_address() == self.privacy_contract.read(), errors::CALLER_NOT_PRIVACY,
            );
            let sub_account = self.get_or_deploy_sub_account(:commitment);
            let notes = record_pre_balances(sub_account, open_notes);
            sub_account.execute(invokes);
            self.collect_open_notes(:sub_account, :notes)
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

    #[abi(embed_v0)]
    impl UpgradeableImpl of IUpgradeable<ContractState> {
        /// Replaces the contract class hash with `new_class_hash`. Owner-only.
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            self.upgradeable.upgrade(new_class_hash);
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
                class_hash: self.sub_account_class_hash.read(),
                contract_address_salt: commitment,
                calldata: array![].span(),
                deploy_from_zero: false,
            )
                .unwrap_syscall();
            self.sub_accounts.write(commitment, sub_account_addr);
            ISubAccountDispatcher { contract_address: sub_account_addr }
        }

        /// Collects, for each `(note_id, token, pre_balance)` in `notes`, the balance the
        /// interaction added to `sub_account` (its current balance minus `pre_balance`) into this
        /// anonymizer, approves the privacy contract to pull it, and returns one deposit per note.
        /// Only the sub-account can move its own funds, so each transfer is routed through it.
        fn collect_open_notes(
            self: @ContractState,
            sub_account: ISubAccountDispatcher,
            notes: Span<(felt252, ContractAddress, u256)>,
        ) -> Span<OpenNoteDeposit> {
            let anonymizer = get_contract_address();
            let privacy_contract = self.privacy_contract.read();
            let mut deposits: Array<OpenNoteDeposit> = array![];
            for note in notes {
                let (note_id, token, pre_balance) = *note;
                let erc20 = IERC20Dispatcher { contract_address: token };
                // Collect only what the interaction added; clamp so a decrease yields zero.
                let post_balance = erc20.balance_of(account: sub_account.contract_address);
                let amount = if post_balance > pre_balance {
                    post_balance - pre_balance
                } else {
                    0
                };

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

                erc20.approve(spender: privacy_contract, :amount);
                let amount: u128 = amount.try_into().expect(errors::COLLECTED_AMOUNT_OVERFLOW);
                deposits.append(OpenNoteDeposit { note_id, token, amount });
            }
            deposits.span()
        }
    }

    /// Records each open note's token together with the sub-account's current balance of it, so
    /// `collect_open_notes` can later credit only the delta the interaction adds. Each returned
    /// entry is `(note_id, token, pre_balance)`.
    fn record_pre_balances(
        sub_account: ISubAccountDispatcher, open_notes: Span<(felt252, ContractAddress)>,
    ) -> Span<(felt252, ContractAddress, u256)> {
        let mut notes: Array<(felt252, ContractAddress, u256)> = array![];
        for note in open_notes {
            let (note_id, token) = *note;
            let pre_balance = IERC20Dispatcher { contract_address: token }
                .balance_of(account: sub_account.contract_address);
            notes.append((note_id, token, pre_balance));
        }
        notes.span()
    }
}
