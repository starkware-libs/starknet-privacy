#[starknet::contract]
pub mod SwapExecutor {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address};
    use crate::swap_executor::errors;
    use crate::swap_executor::interface::ISwapExecutor;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl SwapExecutorImpl of ISwapExecutor<ContractState> {
        fn swap(
            ref self: ContractState,
            swap_contract: ContractAddress,
            swap_selector: felt252,
            swap_calldata: Span<felt252>,
            in_token: ContractAddress,
            out_token: ContractAddress,
            in_amount: u128,
        ) -> u128 {
            // Validate all inputs are non-zero.
            assert(swap_contract.is_non_zero(), errors::ZERO_SWAP_CONTRACT);
            assert(swap_selector.is_non_zero(), errors::ZERO_SWAP_SELECTOR);
            assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN);
            assert(out_token.is_non_zero(), errors::ZERO_OUT_TOKEN);
            assert(in_amount.is_non_zero(), errors::ZERO_AMOUNT);

            let self_address = get_contract_address();
            let in_erc20 = IERC20Dispatcher { contract_address: in_token };
            let out_erc20 = IERC20Dispatcher { contract_address: out_token };

            // Approve swap contract to spend input tokens.
            in_erc20.approve(spender: swap_contract, amount: in_amount.into());

            // Get output token balance before swap.
            let balance_before = out_erc20.balance_of(account: self_address);

            // Execute swap (propagates error from swap contract if it fails).
            call_contract_syscall(
                address: swap_contract,
                entry_point_selector: swap_selector,
                calldata: swap_calldata,
            )
                .unwrap_syscall();

            // Calculate output amount.
            let balance_after = out_erc20.balance_of(account: self_address);
            let out_amount: u128 = (balance_after - balance_before).try_into().unwrap();

            // Approve caller to transfer received output funds.
            out_erc20.approve(spender: get_caller_address(), amount: out_amount.into());

            out_amount
        }
    }
}
