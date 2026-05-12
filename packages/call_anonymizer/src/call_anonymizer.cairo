//! Generic call dispatcher used as a privacy-pool invoke target.
//!
//! `CallAnonymizer` is a minimal contract whose sole role is to dispatch an array of `Call`s on
//! behalf of the privacy pool, via the protocol's `privacy_invoke` selector. It implements no
//! deposit logic and returns an empty `Span<OpenNoteDeposit>`: any open-note fills must be
//! produced by the dispatched calls themselves (typically a `pool.deposit_to_open_note(...)`
//! reached via SNIP-9 outside execution).
//!
//! ## Motivation
//!
//! The privacy pool's `InvokeExternal` action calls a single contract at the hardcoded
//! `privacy_invoke` selector and feeds its return data back into the pool. Plain Starknet
//! accounts implement neither that selector nor the OpenNoteDeposit return contract, so flows
//! such as ephemeral-account SNIP-9 deposits need a small intermediary that:
//! - is callable via `privacy_invoke`, and
//! - can dispatch arbitrary user-signed calls on its behalf.
//!
//! Folding both responsibilities into this dispatcher gives a single reusable contract that
//! covers ephemeral-account SNIP-9 deposits, transferFrom-based pulls, multi-step pre-conditions,
//! and any other "execute a few signed calls before the pool fills a note" pattern, without
//! committing the contract to a particular shape of `(note_id, token, amount, ...)` arguments.
//!
//! ## Flow
//!
//! 1. The pool issues `privacy_invoke(calls)` against this contract.
//! 2. The contract syscalls each `Call` in order. `get_caller_address()` inside each dispatched
//!    call is this contract's address.
//! 3. The contract returns an empty `Span<OpenNoteDeposit>`. The pool's `_apply_invoke`
//!    deserializes that and skips the fill loop.
//! 4. Any open-note fill produced by the user's flow must come from a `pool.deposit_to_open_note`
//!    call reached via one of the dispatched calls (e.g. inside an `execute_from_outside_v2`).
//!
//! ## Open question for reviewers
//!
//! Should this dispatcher enforce a balance-delta check on each ERC-20 it touches (assert that
//! every token's balance is unchanged across the dispatch, so the contract never silently
//! accumulates funds)? Today it does not — flows are expected to fully consume funds inside the
//! dispatched calls, and protocol-level checks (e.g. `pool.deposit_to_open_note`'s own
//! `transferFrom` reverts on under-funding) catch mis-amounts at the right layer. Reconsider if
//! a future flow needs to *transit* funds through this contract rather than passing them straight
//! to a destination.

use privacy::objects::OpenNoteDeposit;
use starknet::account::Call;

#[starknet::interface]
pub trait ICallAnonymizer<T> {
    /// Dispatches `calls` in order via `call_contract_syscall`. Returns an empty
    /// `Span<OpenNoteDeposit>` so the pool's `_apply_invoke` runs no fills of its own; any
    /// open-note fills must come from the dispatched calls themselves.
    ///
    /// Called by the privacy pool via the `privacy_invoke` selector.
    fn privacy_invoke(ref self: T, calls: Array<Call>) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod CallAnonymizer {
    use privacy::objects::OpenNoteDeposit;
    use starknet::SyscallResultTrait;
    use starknet::account::Call;
    use starknet::syscalls::call_contract_syscall;
    use super::ICallAnonymizer;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl CallAnonymizerImpl of ICallAnonymizer<ContractState> {
        fn privacy_invoke(ref self: ContractState, calls: Array<Call>) -> Span<OpenNoteDeposit> {
            for call in calls.span() {
                let Call { to, selector, calldata } = *call;
                call_contract_syscall(address: to, entry_point_selector: selector, :calldata)
                    .unwrap_syscall();
            }
            ArrayTrait::<OpenNoteDeposit>::new().span()
        }
    }
}
