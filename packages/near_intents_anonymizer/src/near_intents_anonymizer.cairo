//! Anonymous cross-chain swap helper bridging the Starknet privacy pool to
//! NEAR Intents.
//!
//! ## Flow
//!
//! - **Tx 1 (Dispatch, pool tx).** User submits a privacy-pool proven tx with
//!   client actions `UseNote → CreateOpenNote(output_token, depositor=self)
//!   → CreateOpenNote(input_token, depositor=self, refund slot)
//!   → Withdraw(input_token → self, in_amount)
//!   → InvokeExternal(self.privacy_invoke(...))`. The pool pushes
//!   `in_amount` of `asset_in` to this contract and then invokes us. We
//!   forward the funds to the 1Click `deposit_address` on Starknet and record
//!   the swap in `pending_swaps[swap_id]`. The two open notes sit empty,
//!   awaiting `finalize` or `recover`.
//!
//! - **Tx 2a (Finalize, plain tx).** Once NEAR Intents has settled the output
//!   to `output_mailbox(swap_id)`, anyone can call `finalize(swap_id)`. We
//!   lazily deploy a `MailboxReceiver` at the precomputed address, sweep the
//!   `asset_out` balance into ourselves, approve the pool, and call the pool's
//!   `deposit_to_open_note` to credit the user's pre-allocated open note.
//!
//! - **Tx 2b (Recover, plain tx).** If the swap fails and 1Click refunds to
//!   `refund_mailbox(swap_id)`, anyone can call `recover(swap_id)`. Same
//!   shape, on the refund leg.
//!
//! `finalize` and `recover` are mutually exclusive per swap (status flag +
//! `deploy_syscall` collision protection at the same mailbox address).
//!
//! ## SDK interface (single source of truth)
//!
//! - `anonymizer_address` — post-deploy, immutable.
//! - `receiver_class_hash` — post-declare, immutable.
//! - `MailboxReceiver` constructor calldata = `[anonymizer_address]`.
//! - Salt-domain constants: `'NIA_OUTPUT_V1'`, `'NIA_REFUND_V1'`.
//! - `privacy_invoke` calldata layout = `(swap_id, asset_in, in_amount,
//!   asset_out, note_id_out, refund_note_id, deposit_address, note_id_unused)`.
//! - `finalize` / `recover` calldata = `(swap_id,)`.
//! - The SDK MUST set `depositor = anonymizer_address` on both
//!   `CreateOpenNote` actions in Tx 1. The anonymizer verifies this before
//!   forwarding funds; a misaligned depositor reverts Tx 1.

use core::pedersen::pedersen;
use privacy::objects::OpenNoteDeposit;
use starknet::{ClassHash, ContractAddress};

pub mod errors {
    // construction
    pub const ZERO_PRIVACY_ADDRESS: felt252 = 'NIA_ZERO_PRIVACY';
    pub const ZERO_CLASS_HASH: felt252 = 'NIA_ZERO_CLASS';
    // auth
    pub const CALLER_NOT_PRIVACY: felt252 = 'NIA_CALLER_NOT_PRIVACY';
    // privacy_invoke input
    pub const ZERO_SWAP_ID: felt252 = 'NIA_ZERO_SWAP_ID';
    pub const ZERO_ASSET_IN: felt252 = 'NIA_ZERO_ASSET_IN';
    pub const ZERO_ASSET_OUT: felt252 = 'NIA_ZERO_ASSET_OUT';
    pub const ZERO_AMOUNT: felt252 = 'NIA_ZERO_AMOUNT';
    pub const ZERO_DEPOSIT_ADDRESS: felt252 = 'NIA_ZERO_DEPOSIT';
    pub const ZERO_NOTE_ID: felt252 = 'NIA_ZERO_NOTE_ID';
    pub const NOTE_IDS_EQUAL: felt252 = 'NIA_NOTE_IDS_EQUAL';
    pub const SWAP_ID_TAKEN: felt252 = 'NIA_SWAP_ID_TAKEN';
    // pre-created-note checks
    pub const OUT_NOTE_TOKEN_MISMATCH: felt252 = 'NIA_OUT_NOTE_TOK';
    pub const REFUND_NOTE_TOKEN_MISMATCH: felt252 = 'NIA_REFUND_NOTE_TOK';
    pub const OUT_NOTE_NOT_OURS: felt252 = 'NIA_OUT_DEPOSITOR';
    pub const REFUND_NOTE_NOT_OURS: felt252 = 'NIA_REFUND_DEPOSITOR';
    pub const INSUFFICIENT_BALANCE: felt252 = 'NIA_INSUFFICIENT_BAL';
    // inbound (register_inbound) — reuses ZERO_SWAP_ID / ZERO_ASSET_OUT /
    // ZERO_NOTE_ID / SWAP_ID_TAKEN / OUT_NOTE_NOT_OURS where the meaning is
    // identical to the outbound path.
    pub const NO_INBOUND_RECOVERY: felt252 = 'NIA_NO_INBOUND_RECOVERY';
    // finalize/recover
    pub const SWAP_NOT_PENDING: felt252 = 'NIA_SWAP_NOT_PENDING';
    pub const MAILBOX_MISMATCH: felt252 = 'NIA_MBX_MISMATCH';
    pub const AMOUNT_OVERFLOW: felt252 = 'NIA_OVERFLOW';
    pub const ZERO_OUT: felt252 = 'NIA_ZERO_OUT';
    // address derivation
    pub const ADDR_OUT_OF_RANGE: felt252 = 'NIA_ADDR_RANGE';
}

/// Per-swap state lifecycle.
#[derive(Drop, Serde, Copy, PartialEq, Debug, Default, starknet::Store)]
pub enum SwapStatus {
    /// Empty slot. Distinct from any post-Start state.
    #[default]
    None,
    /// Tx 1 succeeded; awaiting NEAR Intents settlement.
    Pending,
    /// `finalize` succeeded; user's output open note has been filled.
    Finalized,
    /// `recover` succeeded; user's refund open note has been filled.
    Recovered,
}

/// One row of `pending_swaps`. All fields zero / None for unset slots.
#[derive(Drop, Serde, Copy, PartialEq, Debug, starknet::Store)]
pub struct PendingSwap {
    pub asset_in: ContractAddress,
    pub asset_out: ContractAddress,
    pub note_id_out: felt252,
    pub refund_note_id: felt252,
    pub status: SwapStatus,
}

#[starknet::interface]
pub trait INearIntentsAnonymizer<T> {
    /// Called by the privacy pool inside Tx 1's `InvokeExternal`. Records a
    /// new swap and forwards `in_amount` of `asset_in` (already pushed to us
    /// by the preceding `Withdraw` action) to NEAR Intents' `deposit_address`.
    ///
    /// Returns an empty span — the two open notes referenced by
    /// `note_id_out` / `refund_note_id` stay empty and are filled later by
    /// `finalize` or `recover` via the pool's `deposit_to_open_note`.
    ///
    /// Reverts on bad inputs, duplicate `swap_id`, foreign-caller, or if
    /// either open note has the wrong token or wrong depositor (which would
    /// strand funds).
    fn privacy_invoke(
        ref self: T,
        swap_id: felt252,
        asset_in: ContractAddress,
        in_amount: u128,
        asset_out: ContractAddress,
        note_id_out: felt252,
        refund_note_id: felt252,
        deposit_address: ContractAddress,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;

    /// Register an inbound (on-ramp) swap. Called directly by the user from a
    /// regular Starknet tx (not via the pool's `InvokeExternal`). Reserves
    /// the swap slot for the caller-bound `effective_swap_id =
    /// pedersen(caller, swap_id)`; the user is responsible for sending
    /// `asset_in` on a foreign chain to the 1Click depositAddress, with
    /// `recipient = output_mailbox(effective_swap_id)`. On settlement, anyone
    /// calls `finalize(effective_swap_id)` and the user's pre-created open
    /// note (with depositor = anonymizer) is filled.
    ///
    /// `swap_id` is *caller-namespaced*: two different users can both pass
    /// the same raw `swap_id` without colliding — the storage slot is keyed
    /// by `effective_swap_id`. The SDK must compute the same
    /// `effective_swap_id` off-chain and pass it everywhere downstream
    /// (1Click `recipient` field, subsequent `finalize` call).
    ///
    /// `deposit_address_hint` is opaque to the contract and surfaced in the
    /// emitted event for off-chain observers; it is *not* validated. The
    /// contract holds no inbound funds — they land at the mailbox directly.
    ///
    /// Reverts: `ZERO_SWAP_ID`, `ZERO_ASSET_OUT`, `ZERO_NOTE_ID`,
    /// `SWAP_ID_TAKEN` (against `effective_swap_id`),
    /// `OUT_NOTE_TOKEN_MISMATCH`, `OUT_NOTE_NOT_OURS`.
    fn register_inbound(
        ref self: T,
        swap_id: felt252,
        asset_out: ContractAddress,
        note_id_out: felt252,
        deposit_address_hint: felt252,
    );

    /// Permissionless. Sweeps the output mailbox for `swap_id` and fills the
    /// user's pre-allocated `note_id_out` via the pool's
    /// `deposit_to_open_note`. For inbound swaps, the caller passes the
    /// `effective_swap_id` they computed and emitted via `register_inbound`.
    fn finalize(ref self: T, swap_id: felt252);

    /// Permissionless. Sweeps the refund mailbox for `swap_id` and fills the
    /// user's pre-allocated `refund_note_id` via the pool's
    /// `deposit_to_open_note`. Rejects inbound swaps (`NO_INBOUND_RECOVERY`):
    /// the refund leg lives on the foreign chain and has no Starknet mailbox.
    fn recover(ref self: T, swap_id: felt252);

    /// View: deterministic output-leg mailbox address for `swap_id`.
    /// SDK must compute the same value off-chain before requesting the
    /// 1Click quote. For inbound, pass `effective_swap_id`.
    fn output_mailbox(self: @T, swap_id: felt252) -> ContractAddress;
    /// View: deterministic refund-leg mailbox address for `swap_id`.
    fn refund_mailbox(self: @T, swap_id: felt252) -> ContractAddress;
    /// View: current state for a swap. Returns the default (status=None) for
    /// unknown `swap_id`. For inbound, pass `effective_swap_id`.
    fn get_swap(self: @T, swap_id: felt252) -> PendingSwap;

    /// View: derive the caller-bound effective swap id for the inbound flow.
    /// Pure function — `pedersen(user, swap_id)`. Exposed so the SDK can
    /// double-check its off-chain computation against the on-chain formula.
    fn compute_effective_swap_id(
        self: @T, user: ContractAddress, swap_id: felt252,
    ) -> felt252;
}

/// Salt for the output-leg mailbox. Domain-separated so output and refund
/// mailboxes for the same `swap_id` live at different addresses.
pub const OUTPUT_SALT_DOMAIN: felt252 = 'NIA_OUTPUT_V1';
/// Salt for the refund-leg mailbox.
pub const REFUND_SALT_DOMAIN: felt252 = 'NIA_REFUND_V1';
/// `CONTRACT_ADDRESS_PREFIX` per the Starknet OS address-derivation formula.
pub const CONTRACT_ADDRESS_PREFIX: felt252 = 'STARKNET_CONTRACT_ADDRESS';

pub fn output_salt(swap_id: felt252) -> felt252 {
    pedersen(OUTPUT_SALT_DOMAIN, swap_id)
}

pub fn refund_salt(swap_id: felt252) -> felt252 {
    pedersen(REFUND_SALT_DOMAIN, swap_id)
}

/// Chained Pedersen hash with length suffix — the standard array-hash
/// Starknet uses for constructor-calldata and address derivation:
/// `final = pedersen(pedersen(...pedersen(0, x_0)..., x_{n-1}), n)`.
pub fn hash_array(values: Span<felt252>) -> felt252 {
    let mut h: felt252 = 0;
    let mut n: usize = 0;
    for v in values {
        h = pedersen(h, *v);
        n += 1;
    };
    pedersen(h, n.into())
}

/// Compute the deterministic address that `deploy_syscall(class_hash, salt,
/// calldata, deploy_from_zero=false)` returns when invoked from `deployer`.
///
/// `ctor_hash` is `hash_array(calldata)` — pass it precomputed when the same
/// calldata is reused across many derivations.
pub fn compute_address(
    deployer: ContractAddress, class_hash: ClassHash, salt: felt252, ctor_hash: felt252,
) -> ContractAddress {
    let elements = array![
        CONTRACT_ADDRESS_PREFIX, deployer.into(), salt, class_hash.into(), ctor_hash,
    ];
    let h = hash_array(elements.span());
    h.try_into().expect(errors::ADDR_OUT_OF_RANGE)
}

#[starknet::contract]
pub mod NearIntentsAnonymizer {
    use core::num::traits::Zero;
    use core::pedersen::pedersen;
    use crate::mailbox_receiver::{IMailboxReceiverDispatcher, IMailboxReceiverDispatcherTrait};
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::interface::{
        IServerDispatcher, IServerDispatcherTrait, IViewsDispatcher, IViewsDispatcherTrait,
    };
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::syscalls::deploy_syscall;
    use starknet::{
        ClassHash, ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address,
    };
    use super::{
        INearIntentsAnonymizer, PendingSwap, SwapStatus, compute_address, errors, hash_array,
        output_salt, refund_salt,
    };

    #[storage]
    struct Storage {
        privacy_address: ContractAddress,
        receiver_class_hash: ClassHash,
        // Precomputed `hash_array([self_address])` — the constructor-calldata
        // hash for every `MailboxReceiver` deployed by this anonymizer.
        receiver_ctor_hash: felt252,
        pending_swaps: Map<felt252, PendingSwap>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        SwapStarted: SwapStarted,
        SwapFinalized: SwapFinalized,
        SwapRecovered: SwapRecovered,
        InboundRegistered: InboundRegistered,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SwapStarted {
        #[key]
        pub swap_id: felt252,
        pub asset_in: ContractAddress,
        pub asset_out: ContractAddress,
        pub in_amount: u128,
        pub deposit_address: ContractAddress,
        pub note_id_out: felt252,
        pub refund_note_id: felt252,
        pub output_mailbox: ContractAddress,
        pub refund_mailbox: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SwapFinalized {
        #[key]
        pub swap_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SwapRecovered {
        #[key]
        pub swap_id: felt252,
        pub amount: u128,
    }

    /// Emitted by `register_inbound`. The indexed `effective_swap_id` is the
    /// storage key and the swap-id all downstream entry points (`finalize`,
    /// `output_mailbox`, `get_swap`) take. `swap_id` is the raw user-chosen
    /// value (un-namespaced), surfaced for off-chain correlation with the
    /// user's local intent record. `output_mailbox` is precomputed so
    /// off-chain observers don't have to redo the derivation.
    #[derive(Drop, starknet::Event)]
    pub struct InboundRegistered {
        #[key]
        pub effective_swap_id: felt252,
        pub swap_id: felt252,
        pub user: ContractAddress,
        pub asset_out: ContractAddress,
        pub note_id_out: felt252,
        pub deposit_address_hint: felt252,
        pub output_mailbox: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_address: ContractAddress,
        receiver_class_hash: ClassHash,
    ) {
        assert(privacy_address.is_non_zero(), errors::ZERO_PRIVACY_ADDRESS);
        assert(receiver_class_hash.is_non_zero(), errors::ZERO_CLASS_HASH);
        self.privacy_address.write(privacy_address);
        self.receiver_class_hash.write(receiver_class_hash);

        // Precompute the constructor-calldata hash for `MailboxReceiver`.
        // Calldata is exactly `[self_address]` (one felt).
        let self_addr_felt: felt252 = get_contract_address().into();
        let calldata = array![self_addr_felt];
        self.receiver_ctor_hash.write(hash_array(calldata.span()));
    }

    #[abi(embed_v0)]
    pub impl Impl of INearIntentsAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            swap_id: felt252,
            asset_in: ContractAddress,
            in_amount: u128,
            asset_out: ContractAddress,
            note_id_out: felt252,
            refund_note_id: felt252,
            deposit_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // ---- Authorization ----
            let privacy_addr = self.privacy_address.read();
            assert(get_caller_address() == privacy_addr, errors::CALLER_NOT_PRIVACY);

            // ---- Input validation ----
            assert(swap_id.is_non_zero(), errors::ZERO_SWAP_ID);
            assert(asset_in.is_non_zero(), errors::ZERO_ASSET_IN);
            assert(asset_out.is_non_zero(), errors::ZERO_ASSET_OUT);
            assert(in_amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(deposit_address.is_non_zero(), errors::ZERO_DEPOSIT_ADDRESS);
            assert(note_id_out.is_non_zero(), errors::ZERO_NOTE_ID);
            assert(refund_note_id.is_non_zero(), errors::ZERO_NOTE_ID);
            assert(note_id_out != refund_note_id, errors::NOTE_IDS_EQUAL);
            // `note_id` is unused; carried only to match the SDK calldata
            // convention for `privacy_invoke` helpers.
            let _ = note_id;

            // ---- Slot uniqueness ----
            let existing = self.pending_swaps.entry(swap_id).read();
            assert(existing.status == SwapStatus::None, errors::SWAP_ID_TAKEN);

            // ---- Open-note depositor verification ----
            // Both open notes were already written to pool storage by the
            // preceding `CreateOpenNote` actions in this same tx (phase 5 <
            // INVOKE phase 7). Read them back and verify the user set us as
            // the depositor for both; otherwise `finalize`/`recover` would
            // later fail with `CALLER_NOT_DEPOSITOR`, stranding funds.
            let self_addr = get_contract_address();
            let pool_views = IViewsDispatcher { contract_address: privacy_addr };
            let out_note = pool_views.get_note(note_id: note_id_out);
            let refund_note = pool_views.get_note(note_id: refund_note_id);
            assert(out_note.token == asset_out, errors::OUT_NOTE_TOKEN_MISMATCH);
            assert(refund_note.token == asset_in, errors::REFUND_NOTE_TOKEN_MISMATCH);
            assert(out_note.depositor == self_addr, errors::OUT_NOTE_NOT_OURS);
            assert(refund_note.depositor == self_addr, errors::REFUND_NOTE_NOT_OURS);

            // ---- Defensive balance check + forward to 1Click ----
            let in_erc20 = IERC20Dispatcher { contract_address: asset_in };
            let held = in_erc20.balance_of(account: self_addr);
            assert(held >= in_amount.into(), errors::INSUFFICIENT_BALANCE);
            in_erc20.transfer(recipient: deposit_address, amount: in_amount.into());

            // ---- Persist swap + emit ----
            self
                .pending_swaps
                .entry(swap_id)
                .write(
                    PendingSwap {
                        asset_in,
                        asset_out,
                        note_id_out,
                        refund_note_id,
                        status: SwapStatus::Pending,
                    },
                );

            self
                .emit(
                    Event::SwapStarted(
                        SwapStarted {
                            swap_id,
                            asset_in,
                            asset_out,
                            in_amount,
                            deposit_address,
                            note_id_out,
                            refund_note_id,
                            output_mailbox: self.compute_output_mailbox(swap_id),
                            refund_mailbox: self.compute_refund_mailbox(swap_id),
                        },
                    ),
                );

            [].span()
        }

        fn finalize(ref self: ContractState, swap_id: felt252) {
            let state = self.pending_swaps.entry(swap_id).read();
            assert(state.status == SwapStatus::Pending, errors::SWAP_NOT_PENDING);

            let amount = self
                .deploy_and_sweep(
                    swap_id: swap_id,
                    salt: output_salt(swap_id),
                    expected_mailbox: self.compute_output_mailbox(swap_id),
                    token: state.asset_out,
                );

            self
                .deposit_to_pool_note(
                    note_id: state.note_id_out, token: state.asset_out, amount: amount,
                );

            self
                .pending_swaps
                .entry(swap_id)
                .write(PendingSwap { status: SwapStatus::Finalized, ..state });

            self.emit(Event::SwapFinalized(SwapFinalized { swap_id, amount }));
        }

        fn recover(ref self: ContractState, swap_id: felt252) {
            let state = self.pending_swaps.entry(swap_id).read();
            assert(state.status == SwapStatus::Pending, errors::SWAP_NOT_PENDING);
            // Inbound entries have `asset_in == 0` and `refund_note_id == 0`
            // (no Starknet refund leg — refunds happen on the foreign chain).
            assert(state.asset_in.is_non_zero(), errors::NO_INBOUND_RECOVERY);

            let amount = self
                .deploy_and_sweep(
                    swap_id: swap_id,
                    salt: refund_salt(swap_id),
                    expected_mailbox: self.compute_refund_mailbox(swap_id),
                    token: state.asset_in,
                );

            self
                .deposit_to_pool_note(
                    note_id: state.refund_note_id, token: state.asset_in, amount: amount,
                );

            self
                .pending_swaps
                .entry(swap_id)
                .write(PendingSwap { status: SwapStatus::Recovered, ..state });

            self.emit(Event::SwapRecovered(SwapRecovered { swap_id, amount }));
        }

        fn register_inbound(
            ref self: ContractState,
            swap_id: felt252,
            asset_out: ContractAddress,
            note_id_out: felt252,
            deposit_address_hint: felt252,
        ) {
            // Input validation. `swap_id` here is the raw user value, NOT
            // the storage key — collisions across users are resolved by
            // namespacing into `effective_swap_id` below.
            assert(swap_id.is_non_zero(), errors::ZERO_SWAP_ID);
            assert(asset_out.is_non_zero(), errors::ZERO_ASSET_OUT);
            assert(note_id_out.is_non_zero(), errors::ZERO_NOTE_ID);

            let user = get_caller_address();
            let effective_swap_id = pedersen(user.into(), swap_id);

            // Slot uniqueness — keyed by the caller-namespaced id so two
            // users can never lock each other out of the same raw swap_id.
            let existing = self.pending_swaps.entry(effective_swap_id).read();
            assert(existing.status == SwapStatus::None, errors::SWAP_ID_TAKEN);

            // Verify the user already created the output open note with us
            // as depositor. Catches SDK typos before any funds flow on the
            // foreign chain — finalize would otherwise fail much later with
            // CALLER_NOT_DEPOSITOR after the cross-chain leg settled.
            let pool_views = IViewsDispatcher {
                contract_address: self.privacy_address.read(),
            };
            let out_note = pool_views.get_note(note_id: note_id_out);
            let self_addr = get_contract_address();
            assert(out_note.token == asset_out, errors::OUT_NOTE_TOKEN_MISMATCH);
            assert(out_note.depositor == self_addr, errors::OUT_NOTE_NOT_OURS);

            // Persist with `asset_in == 0` and `refund_note_id == 0` —
            // sentinels for the inbound shape that `recover` checks to
            // reject calls cleanly (`NO_INBOUND_RECOVERY`).
            self
                .pending_swaps
                .entry(effective_swap_id)
                .write(
                    PendingSwap {
                        asset_in: Zero::zero(),
                        asset_out,
                        note_id_out,
                        refund_note_id: 0,
                        status: SwapStatus::Pending,
                    },
                );

            self
                .emit(
                    Event::InboundRegistered(
                        InboundRegistered {
                            effective_swap_id,
                            swap_id,
                            user,
                            asset_out,
                            note_id_out,
                            deposit_address_hint,
                            output_mailbox: self.compute_output_mailbox(effective_swap_id),
                        },
                    ),
                );
        }

        fn output_mailbox(self: @ContractState, swap_id: felt252) -> ContractAddress {
            self.compute_output_mailbox(swap_id)
        }

        fn refund_mailbox(self: @ContractState, swap_id: felt252) -> ContractAddress {
            self.compute_refund_mailbox(swap_id)
        }

        fn get_swap(self: @ContractState, swap_id: felt252) -> PendingSwap {
            self.pending_swaps.entry(swap_id).read()
        }

        fn compute_effective_swap_id(
            self: @ContractState, user: ContractAddress, swap_id: felt252,
        ) -> felt252 {
            pedersen(user.into(), swap_id)
        }
    }

    #[generate_trait]
    impl Internal of InternalTrait {
        /// Deploy a `MailboxReceiver` at the precomputed `expected_mailbox`,
        /// then sweep `token` from it. Asserts the deployed address matches
        /// expectations (defense-in-depth — `deploy_syscall` already enforces
        /// determinism, but a mismatch would mean the address-derivation
        /// formula has drifted from the OS, which we want to catch loudly).
        ///
        /// Returns the swept amount narrowed to `u128`.
        fn deploy_and_sweep(
            ref self: ContractState,
            swap_id: felt252,
            salt: felt252,
            expected_mailbox: ContractAddress,
            token: ContractAddress,
        ) -> u128 {
            let _ = swap_id;

            // Constructor calldata is exactly `[self_address]`.
            let self_addr = get_contract_address();
            let self_addr_felt: felt252 = self_addr.into();
            let ctor = array![self_addr_felt];

            let (deployed, _ret) = deploy_syscall(
                class_hash: self.receiver_class_hash.read(),
                contract_address_salt: salt,
                calldata: ctor.span(),
                deploy_from_zero: false,
            )
                .unwrap_syscall();
            assert(deployed == expected_mailbox, errors::MAILBOX_MISMATCH);

            let receiver = IMailboxReceiverDispatcher { contract_address: deployed };
            let swept_u256 = receiver.sweep(token: token);
            let swept: u128 = swept_u256.try_into().expect(errors::AMOUNT_OVERFLOW);
            assert(swept.is_non_zero(), errors::ZERO_OUT);
            swept
        }

        /// Approve the pool to pull `amount` of `token`, then call the pool's
        /// `deposit_to_open_note`. The pool transfers the funds in via
        /// `transfer_from` and writes the note's `packed_value` to
        /// `(OPEN_NOTE_SALT, amount)`.
        fn deposit_to_pool_note(
            ref self: ContractState, note_id: felt252, token: ContractAddress, amount: u128,
        ) {
            let privacy_addr = self.privacy_address.read();
            IERC20Dispatcher { contract_address: token }
                .approve(spender: privacy_addr, amount: amount.into());
            IServerDispatcher { contract_address: privacy_addr }
                .deposit_to_open_note(note_id: note_id, token: token, amount: amount);
        }

        fn compute_output_mailbox(
            self: @ContractState, swap_id: felt252,
        ) -> ContractAddress {
            self.compute_mailbox(salt: output_salt(swap_id))
        }

        fn compute_refund_mailbox(
            self: @ContractState, swap_id: felt252,
        ) -> ContractAddress {
            self.compute_mailbox(salt: refund_salt(swap_id))
        }

        /// Compute the deterministic address that `deploy_syscall` would
        /// return for `(self, receiver_class_hash, salt, [self_address])`.
        fn compute_mailbox(self: @ContractState, salt: felt252) -> ContractAddress {
            compute_address(
                deployer: get_contract_address(),
                class_hash: self.receiver_class_hash.read(),
                salt: salt,
                ctor_hash: self.receiver_ctor_hash.read(),
            )
        }
    }
}

