//! Endur deposit anonymizer for privacy-preserving liquid staking deposits.
//!
//! Integrates with [Endur](https://endur.fi), a liquid staking protocol on Starknet that uses
//! ERC-4626 vaults. Depositing underlying assets mints LST (liquid staking token) shares.
//!
//! ## Contract call details
//!
//! **Deposit** (underlying → LST): Calls `deposit(assets: u256, receiver: ContractAddress)` on
//! the vault (`out_token`). The vault pulls `in_token` (underlying) from the caller after prior
//! approval.

use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

/// IERC-4626 deposit interface used by Endur LST vaults.
#[starknet::interface]
pub trait IERC4626<T> {
    /// Deposits assets into the vault and mints LST shares to the receiver.
    ///
    /// # Arguments
    /// * `assets` - amount of underlying assets to deposit [asset scale]
    /// * `receiver` - address to receive the LST shares
    ///
    /// # Returns
    /// * amount of LST shares minted [SCALE]
    fn deposit(ref self: T, assets: u256, receiver: ContractAddress) -> u256;
}

#[starknet::interface]
pub trait IEndurDepositAnonymizer<T> {
    /// Deposits underlying assets into an Endur LST vault on behalf of the privacy contract.
    ///
    /// Can be called by the privacy contract via the
    /// [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR) selector.
    ///
    /// #### Parameters
    /// - `in_token` (`ContractAddress`) - The underlying asset token address.
    /// - `out_token` (`ContractAddress`) - The Endur LST vault address.
    /// - `assets` (`u256`) - Amount of underlying assets to deposit.
    /// - `note_id` (`felt252`) - The identifier of the open note to deposit the LST to.
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
    /// - The contract must have sufficient `in_token` balance.
    /// - `out_token` must be an Endur ERC-4626 vault.
    ///
    /// #### Flow
    /// 1. Approves the vault to spend `assets` of `in_token`.
    /// 2. Records LST balance, calls `deposit`, calculates received LST amount.
    /// 3. Approves the caller (privacy contract) to transfer the received LST.
    /// 4. Returns `(note_id, out_token, out_amount)`.
    fn privacy_invoke(
        ref self: T,
        in_token: ContractAddress,
        out_token: ContractAddress,
        assets: u256,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

/// Error codes for Endur deposit operations.
pub mod errors {
    pub const ZERO_IN_TOKEN: felt252 = 'ZERO_IN_TOKEN';
    pub const ZERO_OUT_TOKEN: felt252 = 'ZERO_OUT_TOKEN';
    pub const ZERO_ASSETS: felt252 = 'ZERO_ASSETS';
    pub const TOKENS_EQUAL: felt252 = 'TOKENS_EQUAL';
    pub const RECEIVED_AMOUNT_OVERFLOW: felt252 = 'RECEIVED_AMOUNT_OVERFLOW';
    pub const ZERO_OUT_AMOUNT: felt252 = 'ZERO_OUT_AMOUNT';
}

/// Endur deposit anonymizer contract that performs ERC-4626 deposits on behalf of the privacy
/// contract.
#[starknet::contract]
pub mod EndurDepositAnonymizer {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{
        IEndurDepositAnonymizer, IERC4626Dispatcher, IERC4626DispatcherTrait, errors,
    };

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl EndurDepositAnonymizerImpl of IEndurDepositAnonymizer<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
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

            let balance_before = out_erc20.balance_of(account: self_addr);

            in_erc20.approve(spender: out_token, amount: assets);
            IERC4626Dispatcher { contract_address: out_token }
                .deposit(:assets, receiver: self_addr);

            let balance_after = out_erc20.balance_of(account: self_addr);
            let out_amount: u128 = (balance_after - balance_before)
                .try_into()
                .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
            assert(out_amount.is_non_zero(), errors::ZERO_OUT_AMOUNT);

            out_erc20.approve(spender: privacy_addr, amount: out_amount.into());

            [OpenNoteDeposit { note_id, token: out_token, amount: out_amount }].span()
        }
    }
}
