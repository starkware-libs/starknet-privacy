//! Ekubo swap executor contract: executes a single-hop swap on an Ekubo Router and
//! deposits the output to an open note on the caller (privacy contract).
//!
//! Callable via the privacy contract's Invoke action with
//! [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR) (`privacy_invoke`).
//! One deployed instance can be used with multiple Ekubo pools by passing pool and
//! route params in calldata.

#[starknet::contract]
pub mod EkuboSwapExecutor {
    use core::num::traits::Zero;
    use ekubo::interfaces::router::{
        IRouterDispatcher, IRouterDispatcherTrait, RouteNode, TokenAmount,
    };
    use ekubo::types::i129::i129;
    use ekubo::types::keys::PoolKey;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::ekubo_swap_executor::errors;
    use privacy::ekubo_swap_executor::interface::IEkuboSwapExecutor;
    use privacy::interface::{IServerDispatcher, IServerDispatcherTrait};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};

    #[storage]
    struct Storage {
        router: ContractAddress,
    }

    #[constructor]
    pub(crate) fn constructor(ref self: ContractState, router: ContractAddress) {
        assert(router.is_non_zero(), errors::ZERO_ROUTER);
        self.router.write(router);
    }

    #[abi(embed_v0)]
    pub impl EkuboSwapExecutorImpl of IEkuboSwapExecutor<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            in_token: ContractAddress,
            out_token: ContractAddress,
            in_amount: u128,
            note_id: felt252,
            pool_key: PoolKey,
            sqrt_ratio_limit: u256,
            skip_ahead: u128,
        ) {
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
            let router_addr = self.router.read();
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

            let balance_after = out_erc20.balance_of(account: self_addr);
            let out_amount: u128 = (balance_after - balance_before)
                .try_into()
                .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
            assert(out_amount.is_non_zero(), errors::ZERO_OUT_AMOUNT);

            out_erc20.approve(spender: privacy_addr, amount: out_amount.into());
            IServerDispatcher { contract_address: privacy_addr }
                .deposit_to_open_note(:note_id, token: out_token, amount: out_amount);
        }

        fn get_router(self: @ContractState) -> ContractAddress {
            self.router.read()
        }

        fn set_router(ref self: ContractState, router: ContractAddress) {
            assert(router.is_non_zero(), errors::ZERO_ROUTER);
            self.router.write(router);
        }
    }
}
