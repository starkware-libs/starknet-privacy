//! Mock AMM that implements Ekubo's IRouter::swap and IClear interfaces for testing.
//! Performs a 1:1 swap: keeps output tokens on the router (like real Ekubo) until cleared.
//! Supports noop (clear returns 0) via set_swap_behavior.

/// Behavior for clear: normal (transfer balance to caller), noop (return 0).
#[derive(Copy, Drop, Serde, starknet::Store)]
pub enum SwapBehavior {
    #[default]
    Normal,
    Noop,
    PartialSwap,
}

#[starknet::interface]
pub trait IMockEkuboAMMControl<T> {
    fn set_swap_behavior(ref self: T, mode: SwapBehavior);
}

#[starknet::contract]
pub mod MockEkuboAMM {
    use core::array::Array;
    use core::num::traits::Zero;
    use ekubo::components::clear::IClear;
    use ekubo::interfaces::erc20::{
        IERC20Dispatcher as EkuboIERC20Dispatcher,
        IERC20DispatcherTrait as EkuboIERC20DispatcherTrait,
    };
    use ekubo::interfaces::router::{Depth, IRouter, RouteNode, Swap, TokenAmount};
    use ekubo::types::delta::Delta;
    use ekubo::types::i129::i129;
    use ekubo::types::keys::PoolKey;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
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
            let in_token = token_amount.token;
            let amount_u128 = token_amount.amount.mag;
            let token0 = node.pool_key.token0;

            let consumed = match self.swap_behavior.read() {
                SwapBehavior::Noop | SwapBehavior::Normal => amount_u128,
                SwapBehavior::PartialSwap => amount_u128 / 2,
            };

            // Simulate consuming input tokens so clear(in_token) returns the remainder.
            let in_erc20 = EkuboIERC20Dispatcher { contract_address: in_token };
            let dead_address: ContractAddress = 0xdead.try_into().unwrap();
            in_erc20.transfer(dead_address, consumed.into());

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

    #[abi(embed_v0)]
    impl MockClearImpl of IClear<ContractState> {
        fn clear(self: @ContractState, token: EkuboIERC20Dispatcher) -> u256 {
            Self::clear_minimum(:self, :token, minimum: 0)
        }

        fn clear_minimum(
            self: @ContractState, token: EkuboIERC20Dispatcher, minimum: u256,
        ) -> u256 {
            match self.swap_behavior.read() {
                SwapBehavior::Noop => Zero::zero(),
                SwapBehavior::Normal |
                SwapBehavior::PartialSwap => {
                    let balance = token.balanceOf(get_contract_address());
                    assert(balance >= minimum, 'CLEAR_MINIMUM_NOT_MET');
                    if balance.is_non_zero() {
                        token.transfer(get_caller_address(), balance);
                    }
                    balance
                },
            }
        }

        fn clear_minimum_to_recipient(
            self: @ContractState,
            token: EkuboIERC20Dispatcher,
            minimum: u256,
            recipient: ContractAddress,
        ) -> u256 {
            Zero::zero()
        }
    }
}
