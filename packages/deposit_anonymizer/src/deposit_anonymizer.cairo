//! Deposit anonymizer — mediates a SNIP-9-authorized account deposit into a privacy-pool open
//! note via the pool's `InvokeExternal` action.
//!
//! Two entrypoints:
//!
//! - `deposit_to_open_note(note_id, token, amount) -> OpenNoteDeposit` — called *inside* a
//!   user-signed SNIP-9 outside execution. Pulls funds from the SNIP-9 account (the caller) via
//!   `transferFrom` (the caller must have pre-approved this contract for `amount`). Returns
//!   the constructed `OpenNoteDeposit` so it propagates up the SNIP-9 return chain.
//!
//! - `privacy_invoke(calls) -> Span<OpenNoteDeposit>` — called by the pool. Dispatches each
//!   `Call` in order via `call_contract_syscall`. The **last** call's return value is parsed as
//!   the `Array<Span<felt252>>` produced by `execute_from_outside_v2`, and the **last** inner
//!   `Span` is deserialized as `OpenNoteDeposit`. Approves the pool for the deposit, then
//!   returns it for the pool to fill the note.
//!
//! ## Why this shape
//!
//! The `note_id` is part of the inner `deposit_to_open_note` call's calldata, so the user's
//! SNIP-9 signature commits to it. A front-runner that captures the signed outside execution
//! cannot redirect the deposit to a different note: substituting `note_id` invalidates the
//! signature, and re-using the original payload simply fills the originally-signed note.
//!
//! There is no contract storage — the deposit info flows through return values only.

use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;
use starknet::account::Call;

#[starknet::interface]
pub trait IDepositAnonymizer<T> {
    fn privacy_invoke(ref self: T, calls: Array<Call>) -> Span<OpenNoteDeposit>;
    fn deposit_to_open_note(
        ref self: T, note_id: felt252, token: ContractAddress, amount: u128,
    ) -> OpenNoteDeposit;
}

pub mod errors {
    pub const BAD_OUTSIDE_RETURN: felt252 = 'BAD_OUTSIDE_RETURN';
    pub const EMPTY_INNER_RETURNS: felt252 = 'EMPTY_INNER_RETURNS';
    pub const BAD_DEPOSIT_RETURN: felt252 = 'BAD_DEPOSIT_RETURN';
}

#[starknet::contract]
pub mod DepositAnonymizer {
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::SyscallResultTrait;
    use starknet::account::Call;
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IDepositAnonymizer, errors};

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl Impl of IDepositAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, calls: Array<Call>,
        ) -> Span<OpenNoteDeposit> {
            let mut last_return: Span<felt252> = ArrayTrait::new().span();
            for call in calls.span() {
                let Call { to, selector, calldata } = *call;
                last_return = call_contract_syscall(
                    address: to, entry_point_selector: selector, :calldata,
                )
                    .unwrap_syscall();
            }

            let mut iter = last_return;
            let inner_returns: Array<Span<felt252>> = Serde::deserialize(ref iter)
                .expect(errors::BAD_OUTSIDE_RETURN);
            let n = inner_returns.len();
            assert(n != 0, errors::EMPTY_INNER_RETURNS);

            let mut last_inner = *inner_returns.at(n - 1);
            let deposit: OpenNoteDeposit = Serde::deserialize(ref last_inner)
                .expect(errors::BAD_DEPOSIT_RETURN);

            let pool = get_caller_address();
            IERC20Dispatcher { contract_address: deposit.token }
                .approve(spender: pool, amount: deposit.amount.into());

            [deposit].span()
        }

        fn deposit_to_open_note(
            ref self: ContractState,
            note_id: felt252,
            token: ContractAddress,
            amount: u128,
        ) -> OpenNoteDeposit {
            let depositor = get_caller_address();
            IERC20Dispatcher { contract_address: token }
                .transfer_from(
                    sender: depositor,
                    recipient: get_contract_address(),
                    amount: amount.into(),
                );
            OpenNoteDeposit { note_id, token, amount }
        }
    }
}
