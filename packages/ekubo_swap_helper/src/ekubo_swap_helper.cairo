//! Ekubo swap helper contract: executes a single-hop swap on an Ekubo Router and
//! deposits the output to an open note on the caller (privacy contract).
//!
//! Callable via the privacy contract's Invoke action with
//! [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR) (`privacy_invoke`).
//! One deployed instance can be used with multiple Ekubo pools by passing pool and
//! route params in calldata.

use ekubo::interfaces::router::TokenAmount;
use ekubo::types::keys::PoolKey;
use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

pub mod errors {
    pub const ZERO_ROUTER: felt252 = 'ZERO_ROUTER';
    pub const ZERO_IN_TOKEN: felt252 = 'ZERO_IN_TOKEN';
    pub const ZERO_IN_AMOUNT: felt252 = 'ZERO_IN_AMOUNT';
    pub const NEGATIVE_AMOUNT: felt252 = 'NEGATIVE_AMOUNT';
    pub const TOKEN_MISMATCH_POOL_KEY: felt252 = 'TOKEN_MISMATCH_POOL_KEY';
    pub const IN_TOKEN_NOT_CLEARED: felt252 = 'IN_TOKEN_NOT_CLEARED';
    pub const RECEIVED_AMOUNT_OVERFLOW: felt252 = 'RECEIVED_AMOUNT_OVERFLOW';
    pub const ZERO_OUT_AMOUNT: felt252 = 'ZERO_OUT_AMOUNT';
}

#[starknet::interface]
pub trait IEkuboSwapHelper<T> {
    /// Executes a single-hop swap on the given Ekubo Router and returns appropriate data for
    /// depositing the received output to an open note on the caller (privacy contract).
    ///
    /// Can be called by the privacy contract via
    /// [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR).
    ///
    /// Enforces a full swap (no partial fills) by hardcoding `sqrt_ratio_limit = 0`
    /// and asserting no input tokens remain on the router after the swap.
    ///
    /// #### Parameters
    /// - `router_addr` – Ekubo Router contract address.
    /// - `token_amount` – Input token and amount (ekubo `TokenAmount`; amount must be positive).
    /// - `pool_key` – Ekubo pool key (token0, token1, fee, tick_spacing, extension).
    ///   The output token is derived as the pool token that is not `token_amount.token`.
    /// - `minimum_received` – Minimum output amount (slippage protection, passed to
    ///   `clear_minimum`).
    /// - `skip_ahead` – Route optimization parameter (u128).
    /// - `note_id` – Open note id to deposit the output to.
    ///
    /// #### Preconditions
    /// - The helper must hold at least `token_amount.amount` of `token_amount.token`.
    /// - `token_amount.token` must be one of the two tokens in `pool_key`.
    ///
    /// #### Reverts
    /// - [`ZERO_ROUTER`](errors::ZERO_ROUTER): Thrown if `router_addr` is zero.
    /// - [`ZERO_IN_TOKEN`](errors::ZERO_IN_TOKEN): Thrown if `token_amount.token` is zero.
    /// - [`NEGATIVE_AMOUNT`](errors::NEGATIVE_AMOUNT): Thrown if `token_amount.amount` is negative.
    /// - [`ZERO_IN_AMOUNT`](errors::ZERO_IN_AMOUNT): Thrown if `token_amount.amount` is zero.
    /// - [`TOKEN_MISMATCH_POOL_KEY`](errors::TOKEN_MISMATCH_POOL_KEY): Thrown if
    ///   `token_amount.token` is neither `pool_key.token0` nor `pool_key.token1`.
    /// - [`IN_TOKEN_NOT_CLEARED`](errors::IN_TOKEN_NOT_CLEARED): Thrown if the input token balance
    ///   on the router is not zero after the swap (partial fill).
    /// - [`RECEIVED_AMOUNT_OVERFLOW`](errors::RECEIVED_AMOUNT_OVERFLOW): Thrown if the received
    ///   output amount overflows `u128`.
    /// - [`ZERO_OUT_AMOUNT`](errors::ZERO_OUT_AMOUNT): Thrown if the received output amount is
    ///   zero.
    ///
    /// #### Returns
    /// A span of `OpenNoteDeposit` for the privacy contract to apply.
    fn privacy_invoke(
        ref self: T,
        router_addr: ContractAddress,
        token_amount: TokenAmount,
        pool_key: PoolKey,
        minimum_received: u256,
        skip_ahead: u128,
        note_id: felt252,
    ) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod EkuboSwapHelper {
    use core::num::traits::Zero;
    use ekubo::components::clear::{IClearDispatcher, IClearDispatcherTrait};
    use ekubo::interfaces::erc20::IERC20Dispatcher as EkuboIERC20Dispatcher;
    use ekubo::interfaces::router::{
        IRouterDispatcher, IRouterDispatcherTrait, RouteNode, TokenAmount,
    };
    use ekubo::types::i129::i129;
    use ekubo::types::keys::PoolKey;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::OpenNoteDeposit;
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use starkware_utils::erc20::erc20_utils::checked_transfer;
    use super::{IEkuboSwapHelper, errors};

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl EkuboSwapHelperImpl of IEkuboSwapHelper<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            router_addr: ContractAddress,
            token_amount: TokenAmount,
            pool_key: PoolKey,
            minimum_received: u256,
            skip_ahead: u128,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(router_addr.is_non_zero(), errors::ZERO_ROUTER);

            let TokenAmount {
                token: in_token, amount: i129 { mag: in_amount, sign },
            } = token_amount;
            assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN);
            assert(!sign, errors::NEGATIVE_AMOUNT);
            assert(in_amount.is_non_zero(), errors::ZERO_IN_AMOUNT);

            let out_token = if in_token == pool_key.token0 {
                pool_key.token1
            } else {
                assert(in_token == pool_key.token1, errors::TOKEN_MISMATCH_POOL_KEY);
                pool_key.token0
            };

            let self_addr = get_contract_address();
            let privacy_addr = get_caller_address();
            let out_erc20 = IERC20Dispatcher { contract_address: out_token };

            checked_transfer(
                token_address: in_token, recipient: router_addr, amount: in_amount.into(),
            );

            let router = IRouterDispatcher { contract_address: router_addr };
            let node = RouteNode { pool_key, sqrt_ratio_limit: 0, skip_ahead };
            // Ignore the return value of swap (delta).
            router.swap(:node, :token_amount);

            let clear = IClearDispatcher { contract_address: router_addr };
            let in_token_remaining = clear
                .clear(token: EkuboIERC20Dispatcher { contract_address: in_token });
            assert(in_token_remaining.is_zero(), errors::IN_TOKEN_NOT_CLEARED);

            // Ignore the return value of clear_minimum. We calculate the output amount
            // below.
            let balance_before = out_erc20.balance_of(account: self_addr);
            clear
                .clear_minimum(
                    token: EkuboIERC20Dispatcher { contract_address: out_token },
                    minimum: minimum_received,
                );

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
