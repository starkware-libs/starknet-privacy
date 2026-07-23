//! Sub-account anonymizer for privacy-preserving dapp interactions.
//!
//! Runs arbitrary dapp calls on behalf of the privacy contract through per-identity-commitment
//! [`SubAccount`](starkware_accounts::sub_account::SubAccount) contracts. Each identity
//! commitment maps to a dedicated sub-account that performs the dapp calls and holds the resulting
//! funds; the anonymizer then collects those funds into itself and approves the privacy contract to
//! pull them into open notes. Driving interactions is restricted to the configured privacy
//! contract.

use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;
use privacy::objects::OpenNoteDeposit;
use starknet::account::Call;
use starknet::{ClassHash, ContractAddress};

/// The result of [`privacy_compute`]: an identity commitment that identifies a single sub-account.
pub type IdentityCommitment = felt252;

/// The nonce-independent half of an identity commitment, `hash(identity_key, dapp_name)`.
pub type PartialCommitment = felt252;

/// A sub-account resolved by [`get_sub_accounts`]: its `nonce`, `address`, and whether it is
/// deployed. When `is_deployed` is false, `address` is the deterministic address the sub-account
/// *would* deploy to, computed the same way the deploy syscall derives it.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct SubAccountInfo {
    pub nonce: u64,
    pub address: ContractAddress,
    pub is_deployed: bool,
}

/// How much of the sub-account's `token` balance to collect for an open note.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum CollectPolicy {
    /// Collect the sub-account's entire `token` balance.
    All,
    /// Collect only the balance gained during this interaction.
    Diff,
    /// Collect this exact amount.
    Exact: u128,
}

/// Upper bound on the nonce range a single [`get_sub_accounts`] call may resolve, so a view call
/// can never be driven into an unbounded loop by a caller-supplied range.
pub const MAX_SCAN_RANGE: u64 = 1024;

/// Computes the [`PartialCommitment`](PartialCommitment) `hash(identity_key, dapp_name)`.
pub fn partial_commitment(identity_key: felt252, dapp_name: felt252) -> PartialCommitment {
    PoseidonTrait::new().update(identity_key).update(dapp_name).finalize()
}

/// Computes the full identity commitment `hash(partial_commitment, nonce)`.
pub fn commitment_from_partial(
    partial_commitment: PartialCommitment, nonce: felt252,
) -> IdentityCommitment {
    PoseidonTrait::new().update(partial_commitment).update(nonce).finalize()
}

/// An open note to settle after an interaction.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNote {
    /// The identifier of the open note to deposit to.
    pub note_id: felt252,
    /// The token to deposit. Pass at most one note per token.
    pub token: ContractAddress,
    /// The policy selecting how much of the sub-account's `token` balance to collect for this note.
    pub collect_policy: CollectPolicy,
}

#[starknet::interface]
pub trait ISubAccountAnonymizer<T> {
    /// Derives the identity commitment that identifies a sub-account.
    ///
    /// #### Parameters
    /// - `identity_key` (`felt252`) - A unique handle derived by the privacy pool from a user
    /// identity. It is linked to the user but cannot be traced back to them. Only the holder of the
    /// underlying identity can reproduce it, making it a pseudonymous proof of ownership without
    /// revealing who they are.
    /// - `dapp_name` (`felt252`) - The dapp the sub-account interacts with, scoping identity
    /// commitments per dapp.
    /// - `nonce` (`felt252`) - A nonce that lets one identity derive multiple distinct sub-accounts
    /// for the same dapp.
    ///
    /// #### Returns
    /// - ([`IdentityCommitment`](IdentityCommitment)) - An identity commitment binding to a
    /// single sub-account, computed in two stages as `hash(hash(identity_key, dapp_name), nonce)`.
    /// The inner `hash(identity_key, dapp_name)` is the [`PartialCommitment`](PartialCommitment),
    /// which the nonce-scanning views consume so a single off-chain derivation covers every nonce.
    fn privacy_compute(
        self: @T, identity_key: felt252, dapp_name: felt252, nonce: felt252,
    ) -> IdentityCommitment;

    /// Executes `calls` through the sub-account bound to `identity_commitment` (deploying it on
    /// first use), then collects each requested open-note token from the sub-account and into this
    /// anonymizer, approving the privacy contract to pull the collected amount.
    ///
    /// #### Parameters
    /// - `identity_commitment` ([`IdentityCommitment`](IdentityCommitment)) - identifies the
    /// sub-account; see [`privacy_compute`]. Preimage is off-chain only and unrecoverable from
    /// on-chain data.
    /// - `calls` (`Array<Call>`) - the dapp calls to run as the sub-account.
    /// - `open_notes` ([`Span<OpenNote>`](OpenNote)) - the notes to settle; for each, the amount
    ///   selected by its [`collect_policy`](CollectPolicy) is collected from the sub-account into
    ///   this anonymizer and recorded as a deposit. Pass at most one note per token; otherwise, the
    ///   transaction will fail later in the privacy contract because the second approval overwrites
    ///   the first.
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
    /// - [`ZERO_BALANCE`](errors::ZERO_BALANCE): Thrown if the amount collected for an open note is
    ///   zero (all open notes must be deposited with amount > 0).
    /// - [`NEGATIVE_DIFF`](errors::NEGATIVE_DIFF): Thrown for a `CollectPolicy::Diff` note
    ///   if the interaction reduced the sub-account's `token` balance.
    /// - [`INSUFFICIENT_BALANCE`](errors::INSUFFICIENT_BALANCE): Thrown for a
    ///   `CollectPolicy::Exact` note if the amount exceeds the sub-account's `token` balance.
    /// - [`AMOUNT_OVERFLOW`](errors::AMOUNT_OVERFLOW): Thrown if the amount
    ///   collected for an open note exceeds `u128`.
    fn privacy_invoke_with_computation(
        ref self: T,
        identity_commitment: IdentityCommitment,
        calls: Array<Call>,
        open_notes: Span<OpenNote>,
    ) -> Span<OpenNoteDeposit>;

    /// Resolves the sub-accounts for nonces `[start_nonce, end_nonce)` under `partial_commitment`,
    /// one [`SubAccountInfo`](SubAccountInfo) per nonce in ascending order. A deployed nonce
    /// carries its stored address; an undeployed one carries the deterministic address it would
    /// deploy to (so callers can address a sub-account before it exists). The commitment for each
    /// nonce is `hash(partial_commitment, nonce)`.
    ///
    /// #### Parameters
    /// - `partial_commitment` ([`PartialCommitment`](PartialCommitment)) - the user+dapp half of
    /// the commitment, `hash(identity_key, dapp_name)`.
    /// - `start_nonce` (`u64`) - the first nonce to resolve (inclusive).
    /// - `end_nonce` (`u64`) - the upper bound (exclusive).
    /// - `until_undeployed` (`bool`) - When true, resolution stops at the first undeployed nonce
    /// and that nonce is not returned, so the result is the contiguous deployed prefix of the range.
    /// When false, every nonce in the range is returned regardless of deployment.
    ///
    /// #### Returns
    /// - ([`Span<SubAccountInfo>`](SubAccountInfo)) - one entry per nonce in `[start_nonce,
    /// end_nonce)`, or the deployed prefix of that range when `until_undeployed` is true.
    ///
    /// #### Reverts
    /// - [`INVALID_RANGE`](errors::INVALID_RANGE): Thrown if `end_nonce < start_nonce`.
    /// - [`RANGE_TOO_LARGE`](errors::RANGE_TOO_LARGE): Thrown if `end_nonce - start_nonce` exceeds
    ///   [`MAX_SCAN_RANGE`](MAX_SCAN_RANGE).
    fn get_sub_accounts(
        self: @T,
        partial_commitment: PartialCommitment,
        start_nonce: u64,
        end_nonce: u64,
        until_undeployed: bool,
    ) -> Span<SubAccountInfo>;

    /// Returns the deployed sub-account address bound to `identity_commitment`.
    ///
    /// #### Parameters
    /// - `identity_commitment` ([`IdentityCommitment`](IdentityCommitment)) - The identity
    /// commitment derived by `privacy_compute`.
    ///
    /// #### Returns
    /// - (`ContractAddress`) - The deployed sub-account address, or zero if none has been deployed
    /// for `identity_commitment` yet.
    fn get_sub_account(self: @T, identity_commitment: IdentityCommitment) -> ContractAddress;

    /// Returns the privacy contract authorized to drive interactions.
    ///
    /// #### Returns
    /// - (`ContractAddress`) - The address of the authorized privacy contract.
    fn get_privacy_contract(self: @T) -> ContractAddress;

    /// Returns the class hash of the `SubAccount` contract deployed per identity commitment.
    ///
    /// #### Returns
    /// - (`ClassHash`) - The class hash used when deploying a sub-account.
    fn get_sub_account_class_hash(self: @T) -> ClassHash;
}

/// Error codes for sub-account anonymizer operations.
pub mod errors {
    pub const UNAUTHORIZED_CALLER: felt252 = 'UNAUTHORIZED_CALLER';
    pub const ZERO_BALANCE: felt252 = 'ZERO_BALANCE';
    pub const NEGATIVE_DIFF: felt252 = 'NEGATIVE_DIFF';
    pub const INSUFFICIENT_BALANCE: felt252 = 'INSUFFICIENT_BALANCE';
    pub const AMOUNT_OVERFLOW: felt252 = 'AMOUNT_OVERFLOW';
    pub const RANGE_TOO_LARGE: felt252 = 'RANGE_TOO_LARGE';
    pub const INVALID_RANGE: felt252 = 'INVALID_RANGE';
    /// Internal error.
    pub const ZERO_ADDRESS: felt252 = 'ZERO_ADDRESS';
}

#[starknet::contract]
pub mod SubAccountAnonymizer {
    use core::num::traits::{CheckedSub, SaturatingSub, Zero};
    use openzeppelin::access::accesscontrol::AccessControlComponent;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::utils::deployments::calculate_contract_address_from_deploy_syscall;
    use privacy::objects::OpenNoteDeposit;
    use starknet::account::Call;
    use starknet::storage::{
        StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::deploy_syscall;
    use starknet::{
        ClassHash, ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address,
    };
    use starkware_accounts::sub_account::{ISubAccountDispatcher, ISubAccountDispatcherTrait};
    use starkware_utils::components::common_roles::CommonRolesComponent;
    use starkware_utils::components::common_roles::CommonRolesComponent::InternalTrait as CommonRolesInternalTrait;
    use starkware_utils::components::replaceability::ReplaceabilityComponent;
    use starkware_utils::components::replaceability::ReplaceabilityComponent::InternalReplaceabilityTrait;
    use starkware_utils::storage::iterable_map::{
        IterableMap, IterableMapReadAccessImpl, IterableMapWriteAccessImpl,
    };
    use super::{
        CollectPolicy, ISubAccountAnonymizer, IdentityCommitment, MAX_SCAN_RANGE, OpenNote,
        PartialCommitment, SubAccountInfo, commitment_from_partial, errors, partial_commitment,
    };

    component!(path: ReplaceabilityComponent, storage: replaceability, event: ReplaceabilityEvent);
    component!(path: CommonRolesComponent, storage: common_roles, event: CommonRolesEvent);
    component!(path: AccessControlComponent, storage: access_control, event: AccessControlEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    #[abi(embed_v0)]
    impl ReplaceabilityImpl =
        ReplaceabilityComponent::ReplaceabilityImpl<ContractState>;
    #[abi(embed_v0)]
    impl CommonRolesImpl = CommonRolesComponent::CommonRolesImpl<ContractState>;

    #[storage]
    struct Storage {
        #[substorage(v0)]
        replaceability: ReplaceabilityComponent::Storage,
        #[substorage(v0)]
        common_roles: CommonRolesComponent::Storage,
        #[substorage(v0)]
        access_control: AccessControlComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        /// Address of the authorized privacy contract.
        privacy_contract: ContractAddress,
        /// Class hash of the `SubAccount` contract deployed per identity commitment.
        sub_account_class_hash: ClassHash,
        /// Maps an identity commitment to the sub-account deployed for it.
        sub_accounts: IterableMap<IdentityCommitment, ContractAddress>,
    }

    #[derive(Serde, Copy, Debug, Drop, PartialEq, starknet::Event)]
    pub struct SubAccountDeployed {
        /// The identity commitment the sub-account is bound to.
        #[key]
        pub identity_commitment: IdentityCommitment,
        /// The deployed sub-account address.
        #[key]
        pub sub_account: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ReplaceabilityEvent: ReplaceabilityComponent::Event,
        #[flat]
        CommonRolesEvent: CommonRolesComponent::Event,
        #[flat]
        AccessControlEvent: AccessControlComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        SubAccountDeployed: SubAccountDeployed,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_contract: ContractAddress,
        sub_account_class_hash: ClassHash,
        governance_admin: ContractAddress,
    ) {
        self.privacy_contract.write(privacy_contract);
        self.sub_account_class_hash.write(sub_account_class_hash);
        self.common_roles.initialize(:governance_admin);
        self.replaceability.initialize(upgrade_delay: Zero::zero());
    }

    #[abi(embed_v0)]
    pub impl SubAccountAnonymizerImpl of ISubAccountAnonymizer<ContractState> {
        fn privacy_compute(
            self: @ContractState, identity_key: felt252, dapp_name: felt252, nonce: felt252,
        ) -> IdentityCommitment {
            commitment_from_partial(partial_commitment(identity_key, dapp_name), nonce)
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState,
            identity_commitment: IdentityCommitment,
            calls: Array<Call>,
            open_notes: Span<OpenNote>,
        ) -> Span<OpenNoteDeposit> {
            assert(
                get_caller_address() == self.privacy_contract.read(), errors::UNAUTHORIZED_CALLER,
            );
            let sub_account = self.get_or_deploy_sub_account(:identity_commitment);
            // Pair note with its pre-interaction balance for `CollectPolicy::Diff` notes.
            let note_balance_snapshots = snapshot_open_notes(
                sub_account: sub_account.contract_address, :open_notes,
            );
            sub_account.execute(calls);
            self.collect_open_notes(:sub_account, :note_balance_snapshots)
        }

        fn get_sub_accounts(
            self: @ContractState,
            partial_commitment: PartialCommitment,
            start_nonce: u64,
            end_nonce: u64,
            until_undeployed: bool,
        ) -> Span<SubAccountInfo> {
            assert(end_nonce >= start_nonce, errors::INVALID_RANGE);
            assert(
                end_nonce.saturating_sub(start_nonce) <= MAX_SCAN_RANGE, errors::RANGE_TOO_LARGE,
            );
            let class_hash = self.sub_account_class_hash.read();
            let deployer_address = get_contract_address();
            let mut sub_accounts: Array<SubAccountInfo> = array![];
            for nonce in start_nonce..end_nonce {
                let commitment = commitment_from_partial(partial_commitment, nonce.into());
                let stored = self.get_sub_account(commitment);
                let is_deployed = stored.is_non_zero();
                if until_undeployed && !is_deployed {
                    break;
                }
                // Undeployed sub-accounts resolve to the address the deploy syscall would derive.
                let address = if is_deployed {
                    stored
                } else {
                    calculate_contract_address_from_deploy_syscall(
                        salt: commitment,
                        :class_hash,
                        constructor_calldata: array![].span(),
                        :deployer_address,
                    )
                };
                sub_accounts.append(SubAccountInfo { nonce, address, is_deployed });
            }
            sub_accounts.span()
        }

        fn get_sub_account(
            self: @ContractState, identity_commitment: IdentityCommitment,
        ) -> ContractAddress {
            self.sub_accounts.read(identity_commitment).unwrap_or(Zero::zero())
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
        /// Returns the sub-account bound to `identity_commitment`, deploying a fresh one on first
        /// use. The commitment is the deployment salt, so each one maps to a deterministic address,
        /// and the deployed `SubAccount` records this anonymizer (its deployer) as owner.
        fn get_or_deploy_sub_account(
            ref self: ContractState, identity_commitment: IdentityCommitment,
        ) -> ISubAccountDispatcher {
            if let Some(sub_account_addr) = self.sub_accounts.read(identity_commitment) {
                return ISubAccountDispatcher { contract_address: sub_account_addr };
            }
            let (sub_account, _) = deploy_syscall(
                class_hash: self.sub_account_class_hash.read(),
                contract_address_salt: identity_commitment,
                calldata: array![].span(),
                deploy_from_zero: false,
            )
                .unwrap_syscall();
            // Sanity check: deployed address cannot be zero.
            assert(sub_account.is_non_zero(), errors::ZERO_ADDRESS);
            self.sub_accounts.write(identity_commitment, sub_account);
            self.emit(SubAccountDeployed { identity_commitment, sub_account });
            ISubAccountDispatcher { contract_address: sub_account }
        }

        /// Settles each note, returning one [`OpenNoteDeposit`] per note.
        /// For each note, collects the amount selected by its [`collect_policy`](CollectPolicy)
        /// from the sub-account into this anonymizer and approves the privacy contract to pull it.
        fn collect_open_notes(
            self: @ContractState,
            sub_account: ISubAccountDispatcher,
            note_balance_snapshots: Array<(OpenNote, u256)>,
        ) -> Span<OpenNoteDeposit> {
            let anonymizer = get_contract_address();
            let privacy_contract = self.privacy_contract.read();
            // Transfers are collected into one batch and run through a single
            // `sub_account.execute`.
            let mut transfer_calls: Array<Call> = array![];
            let mut deposits: Array<OpenNoteDeposit> = array![];
            for (note, pre_balance) in note_balance_snapshots {
                let OpenNote { note_id, token, collect_policy } = note;
                let token_contract = IERC20Dispatcher { contract_address: token };
                let balance = token_contract.balance_of(account: sub_account.contract_address);
                let collected = match collect_policy {
                    CollectPolicy::All => balance,
                    CollectPolicy::Diff => balance
                        .checked_sub(pre_balance)
                        .expect(errors::NEGATIVE_DIFF),
                    CollectPolicy::Exact(exact) => {
                        assert(balance >= exact.into(), errors::INSUFFICIENT_BALANCE);
                        exact.into()
                    },
                };
                // Every open note must be deposited with amount > 0.
                assert(collected.is_non_zero(), errors::ZERO_BALANCE);

                transfer_calls
                    .append(build_transfer_call(:token, recipient: anonymizer, amount: collected));
                // TODO: Consider adding an explicit check for duplicate tokens in the open notes
                // instead of relying on the privacy contract to fail due to the approval being
                // overwritten.
                token_contract.approve(spender: privacy_contract, amount: collected);
                let amount: u128 = collected.try_into().expect(errors::AMOUNT_OVERFLOW);
                deposits.append(OpenNoteDeposit { note_id, token, amount });
            }
            sub_account.execute(transfer_calls);
            deposits.span()
        }
    }

    /// Pairs `CollectPolicy::Diff` notes with the sub-account's `token` balance before the
    /// interaction. Other policies are paired with (unused) zero.
    fn snapshot_open_notes(
        sub_account: ContractAddress, open_notes: Span<OpenNote>,
    ) -> Array<(OpenNote, u256)> {
        let mut note_balance_snapshots: Array<(OpenNote, u256)> = array![];
        for note in open_notes {
            let pre_balance = match *note.collect_policy {
                CollectPolicy::Diff => IERC20Dispatcher { contract_address: *note.token }
                    .balance_of(account: sub_account),
                _ => 0,
            };
            note_balance_snapshots.append((*note, pre_balance));
        }
        note_balance_snapshots
    }

    /// Builds a `Call` that transfers `amount` of `token` to `recipient`.
    fn build_transfer_call(
        token: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> Call {
        let mut calldata = array![recipient.into()];
        amount.serialize(ref calldata);
        Call { to: token, selector: selector!("transfer"), calldata: calldata.span() }
    }
}
