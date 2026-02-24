//! Interface for the Ekubo swap executor contract.

use ekubo::types::keys::PoolKey;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IEkuboSwapExecutor<T> {
    /// Executes a single-hop swap on the configured Ekubo Router and deposits the
    /// received output to an open note on the caller (privacy contract).
    ///
    /// Can be called by the privacy contract via
    /// [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR).
    ///
    /// #### Parameters
    /// - `in_token` – Input token address.
    /// - `out_token` – Output token address.
    /// - `in_amount` – Amount of input token to swap.
    /// - `note_id` – Open note id to deposit the output to.
    /// - `pool_key` – Ekubo pool key (token0, token1, fee, tick_spacing, extension).
    /// - `sqrt_ratio_limit` – Price limit for the swap (u256).
    /// - `skip_ahead` – Route optimization parameter (u128).
    ///
    /// #### Preconditions
    /// - The executor must hold at least `in_amount` of `in_token`.
    /// - `in_token` and `out_token` must be the two tokens of `pool_key` (token0, token1).
    /// - Caller must be the privacy contract that owns the open note.
    fn privacy_invoke(
        ref self: T,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
        note_id: felt252,
        pool_key: PoolKey,
        sqrt_ratio_limit: u256,
        skip_ahead: u128,
    );

    /// Returns the configured Ekubo Router address.
    fn get_router(self: @T) -> ContractAddress;

    /// Sets the configured Ekubo Router address.
    fn set_router(ref self: T, router: ContractAddress);
}
