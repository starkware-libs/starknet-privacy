//! Ekubo swap executor contract: executes a single-hop swap on an Ekubo Router and
//! deposits the output to an open note on the caller (privacy contract).
//!
//! Callable via the privacy contract's Invoke action with
//! [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR) (`privacy_invoke`).
//! One deployed instance can be used with multiple Ekubo pools by passing pool and
//! route params in calldata.

use ekubo::types::keys::PoolKey;
use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

pub mod errors {
    pub const ZERO_IN_TOKEN: felt252 = 'ZERO_IN_TOKEN';
    pub const ZERO_OUT_TOKEN: felt252 = 'ZERO_OUT_TOKEN';
    pub const ZERO_IN_AMOUNT: felt252 = 'ZERO_IN_AMOUNT';
    pub const IN_TOKEN_EQUAL_TO_OUT_TOKEN: felt252 = 'IN_TOKEN_EQUAL_TO_OUT_TOKEN';
    pub const INSUFFICIENT_BALANCE: felt252 = 'INSUFFICIENT_BALANCE';
    pub const ZERO_ROUTER: felt252 = 'ZERO_ROUTER';
    pub const RECEIVED_AMOUNT_OVERFLOW: felt252 = 'RECEIVED_AMOUNT_OVERFLOW';
    pub const ZERO_OUT_AMOUNT: felt252 = 'ZERO_OUT_AMOUNT';
    pub const TOKEN_MISMATCH_POOL: felt252 = 'TOKEN_MISMATCH_POOL';
}

#[starknet::interface]
pub trait IEkuboSwapExecutor<T> {
    /// Executes a single-hop swap on the given Ekubo Router and deposits the
    /// received output to an open note on the caller (privacy contract).
    ///
    /// Can be called by the privacy contract via
    /// [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR).
    ///
    /// #### Parameters
    /// - `router_addr` – Ekubo Router contract address.
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
    ///
    /// #### Returns
    /// A span of `OpenNoteDeposit` for the privacy contract to apply.
    fn privacy_invoke(
        ref self: T,
        router_addr: ContractAddress,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
        note_id: felt252,
        pool_key: PoolKey,
        sqrt_ratio_limit: u256,
        skip_ahead: u128,
    ) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod EkuboSwapExecutor {
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
    use super::{IEkuboSwapExecutor, errors};

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl EkuboSwapExecutorImpl of IEkuboSwapExecutor<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            router_addr: ContractAddress,
            in_token: ContractAddress,
            out_token: ContractAddress,
            in_amount: u128,
            note_id: felt252,
            pool_key: PoolKey,
            sqrt_ratio_limit: u256,
            skip_ahead: u128,
        ) -> Span<OpenNoteDeposit> {
            assert(router_addr.is_non_zero(), errors::ZERO_ROUTER);
            assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN);
            assert(out_token.is_non_zero(), errors::ZERO_OUT_TOKEN);
            assert(in_amount.is_non_zero(), errors::ZERO_IN_AMOUNT);
            assert(in_token != out_token, errors::IN_TOKEN_EQUAL_TO_OUT_TOKEN);

            let (pool_token0, pool_token1) = (pool_key.token0, pool_key.token1);
            assert(
                (in_token == pool_token0 && out_token == pool_token1)
                    || (in_token == pool_token1 && out_token == pool_token0),
                errors::TOKEN_MISMATCH_POOL,
            );

            let self_addr = get_contract_address();
            let privacy_addr = get_caller_address();
            let in_erc20 = IERC20Dispatcher { contract_address: in_token };
            let out_erc20 = IERC20Dispatcher { contract_address: out_token };

            assert(
                in_erc20.balance_of(account: self_addr) >= in_amount.into(),
                errors::INSUFFICIENT_BALANCE,
            );
            in_erc20.transfer(recipient: router_addr, amount: in_amount.into());

            let balance_before = out_erc20.balance_of(account: self_addr);

            let node = RouteNode { pool_key, sqrt_ratio_limit, skip_ahead };
            let token_amount = TokenAmount {
                token: in_token, amount: i129 { mag: in_amount, sign: false },
            };

            let router = IRouterDispatcher { contract_address: router_addr };
            router.swap(:node, :token_amount);
            IClearDispatcher { contract_address: router_addr }
                .clear(token: EkuboIERC20Dispatcher { contract_address: out_token });

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
