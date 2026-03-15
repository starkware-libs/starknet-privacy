//! Vesu lending helper for privacy-preserving deposit and withdraw operations.
//!
//! Integrates with [Vesu](https://vesu.xyz), a permissionless lending protocol on Starknet that
//! uses ERC-4626 / SNIP-22 compatible tokenized vaults. Each pool is a vault: depositing underlying
//! assets mints share tokens; withdrawing burns shares and returns underlying.
//!
//! ## Contract call details
//!
//! **Deposit** (underlying → shares): Calls `deposit(assets: u256, receiver: ContractAddress)` on
//! the vault (`out_token`). Calldata: `[amount_low, amount_high, receiver]`. The vault pulls
//! `in_token` (underlying) from the caller after prior approval.
//!
//! **Withdraw** (shares → underlying): Calls `withdraw(assets: u256, receiver: ContractAddress,
//! owner: ContractAddress)`
//! on the vault (`in_token`). Calldata: `[amount_low, amount_high, receiver, owner]`. Burns shares
//! from `owner` and sends underlying to `receiver`.

use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

/// Lending operation to perform on a Vesu vault.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum LendingOperation {
    Deposit,
    Withdraw,
}

#[starknet::interface]
pub trait IVesuLendingHelper<T> {
    /// Executes a lending operation on the VESU lending pool.
    ///
    /// Can be called by the privacy contract via the
    /// [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR) selector.
    ///
    /// #### Parameters
    /// - `operation` ([`LendingOperation`](LendingOperation)) - The lending operation to perform.
    /// - `in_token` (`ContractAddress`) - The token address of the input funds.
    /// - `out_token` (`ContractAddress`) - The token address of the output funds.
    /// - `in_amount` (`u128`) - The amount of input funds.
    /// - `note_id` (`felt252`) - The identifier of the open note to deposit the output to.
    ///
    /// #### Returns
    /// - ([`Span<OpenNoteDeposit>`](privacy::objects::OpenNoteDeposit)) - span of deposits for the
    /// privacy contract to apply.
    ///
    /// #### Preconditions
    /// - `in_token` must not be zero.
    /// - `out_token` must not be zero.
    /// - `in_amount` must not be zero.
    /// - `in_token` must not be equal to `out_token`.
    /// - The contract must have sufficient input token balance.
    /// - On deposit, `out_token` must be a Vesu Token contract.
    /// - On withdraw, `in_token` must be a Vesu Token contract.
    ///
    /// #### Flow
    /// 1. If operation is Deposit, approves Vesu Token contract to spend `in_amount` of in tokens.
    /// 2. Records output token balance, calls the corresponding lending function, calculates
    /// received amount.
    /// 3. Approves the caller (privacy contract) to transfer the received output funds.
    /// 4. Returns (note_id, out_token, out_amount).
    fn privacy_invoke(
        ref self: T,
        operation: LendingOperation,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

/// Constants for Vesu lending operations.
pub mod constants {
    pub const DEPOSIT_SELECTOR: felt252 = selector!("deposit");
    pub const WITHDRAW_SELECTOR: felt252 = selector!("withdraw");
}

/// Error codes for Vesu lending operations.
pub mod errors {
    pub const ZERO_IN_TOKEN: felt252 = 'ZERO_IN_TOKEN';
    pub const ZERO_OUT_TOKEN: felt252 = 'ZERO_OUT_TOKEN';
    pub const ZERO_IN_AMOUNT: felt252 = 'ZERO_IN_AMOUNT';
    pub const TOKENS_EQUAL: felt252 = 'TOKENS_EQUAL';
    pub const RECEIVED_AMOUNT_OVERFLOW: felt252 = 'RECEIVED_AMOUNT_OVERFLOW';
    pub const ZERO_OUT_AMOUNT: felt252 = 'ZERO_OUT_AMOUNT';
}

/// Vesu lending helper contract that performs Vesu deposit/withdraw on behalf of the privacy
/// contract.
#[starknet::contract]
pub mod VesuLendingHelper {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address};
    use super::constants::{DEPOSIT_SELECTOR, WITHDRAW_SELECTOR};
    use super::{IVesuLendingHelper, LendingOperation, errors};

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl VesuLendingHelperImpl of IVesuLendingHelper<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            operation: LendingOperation,
            in_token: ContractAddress,
            out_token: ContractAddress,
            in_amount: u128,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN);
            assert(out_token.is_non_zero(), errors::ZERO_OUT_TOKEN);
            assert(in_amount.is_non_zero(), errors::ZERO_IN_AMOUNT);
            assert(in_token != out_token, errors::TOKENS_EQUAL);

            let self_addr = get_contract_address();
            let privacy_addr = get_caller_address();
            let in_erc20 = IERC20Dispatcher { contract_address: in_token };
            let out_erc20 = IERC20Dispatcher { contract_address: out_token };

            // TODO: Consider asserting balance of in token >= in_amount.

            // Get output token balance before operation.
            let balance_before = out_erc20.balance_of(account: self_addr);

            // Execute operation (propagates error from Vesu Token contract if it fails).
            if operation == LendingOperation::Deposit {
                // Approve Vesu Token contract to spend `in_amount` of `in_token`.
                in_erc20.approve(spender: out_token, amount: in_amount.into());
                call_contract_syscall(
                    address: out_token,
                    entry_point_selector: DEPOSIT_SELECTOR,
                    // Amount as u256: low = in_amount, high = 0 (in_amount fits in u128).
                    calldata: [in_amount.into(), Zero::zero(), self_addr.into()].span(),
                )
                    .unwrap_syscall();
            } else { // Withdraw operation.
                call_contract_syscall(
                    address: in_token,
                    entry_point_selector: WITHDRAW_SELECTOR,
                    // Amount as u256: low = in_amount, high = 0 (in_amount fits in u128).
                    calldata: [in_amount.into(), Zero::zero(), self_addr.into(), self_addr.into()]
                        .span(),
                )
                    .unwrap_syscall();
            }

            // Calculate output amount.
            let balance_after = out_erc20.balance_of(account: self_addr);
            let out_amount: u128 = (balance_after - balance_before)
                .try_into()
                .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
            assert(out_amount.is_non_zero(), errors::ZERO_OUT_AMOUNT);

            // Approve caller (privacy contract) to transfer received output funds.
            out_erc20.approve(spender: privacy_addr, amount: out_amount.into());

            // Returns deposit to open note input.
            [OpenNoteDeposit { note_id, token: out_token, amount: out_amount }].span()
        }
    }
}
