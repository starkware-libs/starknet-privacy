//! Mock AMM that implements Ekubo's IRouter and IClear interfaces for testing.
//! After swap(), output tokens are held by this contract; the caller collects them via clear().
//! Output amount is controlled by pre-funding the mock with the desired amount of out_token.

#[starknet::contract]
pub mod MockEkuboAMM {
    use core::array::Array;
    use core::num::traits::Zero;
    use ekubo::interfaces::router::{Depth, IRouter, RouteNode, Swap, TokenAmount};
    use ekubo::types::delta::Delta;
    use ekubo::types::i129::i129;
    use ekubo::types::keys::PoolKey;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl Clear = ekubo::components::clear::ClearImpl<ContractState>;

    #[abi(embed_v0)]
    impl MockEkuboAMMImpl of IRouter<ContractState> {
        fn swap(ref self: ContractState, node: RouteNode, token_amount: TokenAmount) -> Delta {
            let in_token = token_amount.token;
            let amount_u128 = token_amount.amount.mag;
            // Output tokens are held by this contract; the caller collects them via `clear()`.
            let pos = i129 { mag: amount_u128, sign: false };
            let neg = i129 { mag: amount_u128, sign: true };
            if in_token == node.pool_key.token0 {
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
