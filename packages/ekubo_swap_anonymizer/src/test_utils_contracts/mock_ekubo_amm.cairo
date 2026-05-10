//! Mock AMM that implements Ekubo's `IRouter::swap` and `IClear` interfaces for testing.
//! Performs a 1:1 swap at a fixed rate. Output tokens remain on the router until cleared,
//! mirroring real Ekubo behavior.
//!
//! Swap behavior is configurable via `set_swap_behavior`:
//! - `Normal` (default) – consumes all input, clears full output to caller.
//! - `Noop` – consumes all input but `clear` returns 0 (simulates zero output).
//! - `PartialSwap` – consumes half the input, clears the output (simulates a partial fill
//!   that leaves input tokens on the router).

use ekubo::interfaces::erc20::IERC20Dispatcher as EkuboIERC20Dispatcher;
use ekubo::interfaces::router::{RouteNode, TokenAmount};
use ekubo::types::delta::Delta;

/// Controls how the mock AMM behaves during swap and clear.
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

#[starknet::interface]
pub trait IRouter<T> {
    fn swap(ref self: T, node: RouteNode, token_amount: TokenAmount) -> Delta;
}

#[starknet::interface]
pub trait IClear<T> {
    fn clear(self: @T, token: EkuboIERC20Dispatcher) -> u256;
    fn clear_minimum(self: @T, token: EkuboIERC20Dispatcher, minimum: u256) -> u256;
}

#[starknet::contract]
pub mod MockEkuboAMM {
    use core::array::Array;
    use core::num::traits::Zero;
    use ekubo::interfaces::erc20::{
        IERC20Dispatcher as EkuboIERC20Dispatcher,
        IERC20DispatcherTrait as EkuboIERC20DispatcherTrait,
    };
    use ekubo::interfaces::router::{RouteNode, TokenAmount};
    use ekubo::types::delta::Delta;
    use ekubo::types::i129::i129;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IClear, IMockEkuboAMMControl, IRouter, SwapBehavior};

    const DEAD_ADDRESS: ContractAddress = 'DEAD_ADDRESS'.try_into().unwrap();

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
            in_erc20.transfer(DEAD_ADDRESS, consumed.into());

            let pos = i129 { mag: amount_u128, sign: false };
            let neg = i129 { mag: amount_u128, sign: true };
            if in_token == token0 {
                Delta { amount0: pos, amount1: neg }
            } else {
                Delta { amount0: neg, amount1: pos }
            }
        }
    }

    #[abi(embed_v0)]
    impl MockClearImpl of IClear<ContractState> {
        fn clear(self: @ContractState, token: EkuboIERC20Dispatcher) -> u256 {
            self.clear_minimum(:token, minimum: Zero::zero())
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
    }
}
