//! Mock AMM that implements Ekubo's IRouter::swap interface for testing.
//! Performs a 1:1 swap: pulls input token from caller, sends same amount of the other pool token.
//! Supports noop (return 0 to caller) and overflow (return > u128::MAX) via set_swap_behavior.

/// Behavior for swap: normal (1:1), noop (0 out), overflow (> u128::MAX).
#[derive(Copy, Drop, Serde, starknet::Store)]
pub enum SwapBehavior {
    #[default]
    Normal,
    Noop,
    Overflow,
}

#[starknet::interface]
pub trait IMockEkuboAMMControl<T> {
    fn set_swap_behavior(ref self: T, mode: SwapBehavior);
}

#[starknet::contract]
pub mod MockEkuboAMM {
    use core::array::Array;
    use core::num::traits::Zero;
    use ekubo::interfaces::router::{Depth, IRouter, RouteNode, Swap, TokenAmount};
    use ekubo::types::delta::Delta;
    use ekubo::types::i129::i129;
    use ekubo::types::keys::PoolKey;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::get_caller_address;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starkware_utils::constants::MAX_U128;
    use super::{IMockEkuboAMMControl, SwapBehavior};

    #[storage]
    struct Storage {
        swap_behavior: SwapBehavior,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl MockEkuboAMMControlImpl of IMockEkuboAMMControl<ContractState> {
        fn set_swap_behavior(ref self: ContractState, mode: SwapBehavior) {
            self.swap_behavior.write(mode);
        }
    }

    #[abi(embed_v0)]
    impl MockEkuboAMMImpl of IRouter<ContractState> {
        fn swap(ref self: ContractState, node: RouteNode, token_amount: TokenAmount) -> Delta {
            let caller = get_caller_address();
            let pool_key = node.pool_key;
            let in_token = token_amount.token;
            let amount_u128 = token_amount.amount.mag;
            let amount: u256 = amount_u128.into();
            let (token0, token1) = (pool_key.token0, pool_key.token1);
            let out_token = if in_token == token0 {
                token1
            } else {
                token0
            };

            // Caller (executor) has already transferred in_token to this router before calling
            // swap.
            let behavior = self.swap_behavior.read();
            let out_amount: u256 = match behavior {
                SwapBehavior::Noop => 0,
                SwapBehavior::Overflow => MAX_U128.into() + 1,
                SwapBehavior::Normal => amount,
            };

            IERC20Dispatcher { contract_address: out_token }
                .transfer(recipient: caller, amount: out_amount);

            let pos = i129 { mag: amount_u128, sign: false };
            let neg = i129 { mag: amount_u128, sign: true };
            if in_token == token0 {
                Delta { amount0: pos, amount1: neg }
            } else {
                Delta { amount0: neg, amount1: pos }
            }
        }

        fn multihop_swap(
            ref self: ContractState, route: Array<RouteNode>, token_amount: TokenAmount,
        ) -> Array<Delta> {
            array![Zero::zero()]
        }

        fn multi_multihop_swap(ref self: ContractState, swaps: Array<Swap>) -> Array<Array<Delta>> {
            array![]
        }

        fn quote_multi_multihop_swap(
            self: @ContractState, swaps: Array<Swap>,
        ) -> Array<Array<Delta>> {
            array![]
        }

        fn quote_multihop_swap(
            self: @ContractState, route: Array<RouteNode>, token_amount: TokenAmount,
        ) -> Array<Delta> {
            array![]
        }

        fn quote_swap(self: @ContractState, node: RouteNode, token_amount: TokenAmount) -> Delta {
            Zero::zero()
        }

        fn get_delta_to_sqrt_ratio(
            self: @ContractState, pool_key: PoolKey, sqrt_ratio: u256,
        ) -> Delta {
            Zero::zero()
        }

        fn get_market_depth(self: @ContractState, pool_key: PoolKey, sqrt_percent: u128) -> Depth {
            Depth { token0: 0, token1: 0 }
        }

        fn get_market_depth_v2(
            self: @ContractState, pool_key: PoolKey, percent_64x64: u128,
        ) -> Depth {
            Depth { token0: 0, token1: 0 }
        }

        fn get_market_depth_at_sqrt_ratio(
            self: @ContractState, pool_key: PoolKey, sqrt_ratio: u256, percent_64x64: u128,
        ) -> Depth {
            Depth { token0: 0, token1: 0 }
        }
    }
}
