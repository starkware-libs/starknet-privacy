//! Mock AMM that implements Ekubo's IRouter::swap interface for testing.
//! Performs a 1:1 swap: pulls input token from caller, sends same amount of the other pool token.

#[starknet::contract]
pub mod MockEkuboAMM {
    use ekubo::interfaces::router::{IRouter, RouteNode, TokenAmount};
    use ekubo::types::delta::Delta;
    use ekubo::types::i129::i129;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::{get_caller_address, get_contract_address};

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

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

            IERC20Dispatcher { contract_address: in_token }
                .transfer_from(sender: caller, recipient: get_contract_address(), :amount);
            IERC20Dispatcher { contract_address: out_token }.transfer(recipient: caller, :amount);

            let pos = i129 { mag: amount_u128, sign: false };
            let neg = i129 { mag: amount_u128, sign: true };
            if in_token == token0 {
                Delta { amount0: pos, amount1: neg }
            } else {
                Delta { amount0: neg, amount1: pos }
            }
        }

        fn multihop_swap(
            ref self: ContractState,
            route: core::array::Array<RouteNode>,
            token_amount: TokenAmount,
        ) -> core::array::Array<Delta> {
            array![core::num::traits::Zero::zero()]
        }

        fn multi_multihop_swap(
            ref self: ContractState, swaps: core::array::Array<ekubo::interfaces::router::Swap>,
        ) -> core::array::Array<core::array::Array<Delta>> {
            array![]
        }

        fn quote_multi_multihop_swap(
            self: @ContractState, swaps: core::array::Array<ekubo::interfaces::router::Swap>,
        ) -> core::array::Array<core::array::Array<Delta>> {
            array![]
        }

        fn quote_multihop_swap(
            self: @ContractState, route: core::array::Array<RouteNode>, token_amount: TokenAmount,
        ) -> core::array::Array<Delta> {
            array![]
        }

        fn quote_swap(self: @ContractState, node: RouteNode, token_amount: TokenAmount) -> Delta {
            core::num::traits::Zero::zero()
        }

        fn get_delta_to_sqrt_ratio(
            self: @ContractState, pool_key: ekubo::types::keys::PoolKey, sqrt_ratio: u256,
        ) -> Delta {
            core::num::traits::Zero::zero()
        }

        fn get_market_depth(
            self: @ContractState, pool_key: ekubo::types::keys::PoolKey, sqrt_percent: u128,
        ) -> ekubo::interfaces::router::Depth {
            ekubo::interfaces::router::Depth { token0: 0, token1: 0 }
        }

        fn get_market_depth_v2(
            self: @ContractState, pool_key: ekubo::types::keys::PoolKey, percent_64x64: u128,
        ) -> ekubo::interfaces::router::Depth {
            ekubo::interfaces::router::Depth { token0: 0, token1: 0 }
        }

        fn get_market_depth_at_sqrt_ratio(
            self: @ContractState,
            pool_key: ekubo::types::keys::PoolKey,
            sqrt_ratio: u256,
            percent_64x64: u128,
        ) -> ekubo::interfaces::router::Depth {
            ekubo::interfaces::router::Depth { token0: 0, token1: 0 }
        }
    }
}
