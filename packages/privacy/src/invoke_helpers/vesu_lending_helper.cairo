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

/// Interface for Vesu Token contract that supports deposit and withdraw operations.
///
/// Reference: [vToken deposit &
/// withdraw](https://docs.vesu.xyz/developers/core/vtoken#deposit--withdraw)
#[starknet::interface]
pub trait IVToken<T> {
    /// Deposits assets into the pool and mints vTokens (shares) to the receiver
    /// # Arguments
    /// * `assets` - amount of assets to deposit [asset scale]
    /// * `receiver` - address to receive the vToken shares
    /// # Returns
    /// * amount of vToken shares minted [SCALE]
    fn deposit(ref self: T, assets: u256, receiver: ContractAddress) -> u256;
    /// Withdraws assets from the pool and burns vTokens (shares) from the owner of the vTokens
    /// # Arguments
    /// * `assets` - amount of assets to withdraw [asset scale]
    /// * `receiver` - address to receive the withdrawn assets
    /// * `owner` - address of the owner of the vToken shares
    /// # Returns
    /// * amount of vTokens (shares) burned [SCALE]
    fn withdraw(
        ref self: T, assets: u256, receiver: ContractAddress, owner: ContractAddress,
    ) -> u256;
}

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
    /// - `in_token` (`ContractAddress`) - The token address of the input funds (in withdraw -
    /// vToken).
    /// - `out_token` (`ContractAddress`) - The token address of the output funds (in deposit -
    /// vToken).
    /// - `assets` (`u256`) - amount of assets to deposit/withdraw.
    /// - `note_id` (`felt252`) - The identifier of the open note to deposit the output to.
    ///
    /// #### Returns
    /// - ([`Span<OpenNoteDeposit>`](privacy::objects::OpenNoteDeposit)) - span of deposits for the
    /// privacy contract to apply.
    ///
    /// #### Preconditions
    /// - `in_token` must not be zero.
    /// - `out_token` must not be zero.
    /// - `assets` must not be zero.
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
        assets: u256,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

/// Error codes for Vesu lending operations.
pub mod errors {
    pub const ZERO_IN_TOKEN: felt252 = 'ZERO_IN_TOKEN';
    pub const ZERO_OUT_TOKEN: felt252 = 'ZERO_OUT_TOKEN';
    pub const ZERO_ASSETS: felt252 = 'ZERO_ASSETS';
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
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{
        IVTokenDispatcher, IVTokenDispatcherTrait, IVesuLendingHelper, LendingOperation, errors,
    };

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
            assets: u256,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN);
            assert(out_token.is_non_zero(), errors::ZERO_OUT_TOKEN);
            assert(assets.is_non_zero(), errors::ZERO_ASSETS);
            assert(in_token != out_token, errors::TOKENS_EQUAL);

            let self_addr = get_contract_address();
            let privacy_addr = get_caller_address();
            let in_erc20 = IERC20Dispatcher { contract_address: in_token };
            let out_erc20 = IERC20Dispatcher { contract_address: out_token };

            // Get output token balance before operation.
            let balance_before = out_erc20.balance_of(account: self_addr);

            // Execute operation.
            match operation {
                LendingOperation::Deposit => {
                    // Approve Vesu Token contract (`out_token`) to spend `assets` of `in_token`.
                    in_erc20.approve(spender: out_token, amount: assets);
                    IVTokenDispatcher { contract_address: out_token }
                        .deposit(:assets, receiver: self_addr)
                },
                LendingOperation::Withdraw => {
                    IVTokenDispatcher { contract_address: in_token }
                        .withdraw(:assets, receiver: self_addr, owner: self_addr)
                },
            }

            // Assert output amount is correct.
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
