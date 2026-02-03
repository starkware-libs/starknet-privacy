#[starknet::contract]
pub mod SwapExecutor {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address};
    use crate::swap_executor::errors;
    use crate::swap_executor::interface::ISwapExecutor;

    #[storage]
    struct Storage {
        /// Address of the privacy pool contract.
        privacy_pool: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, privacy_pool: ContractAddress) {
        assert(privacy_pool.is_non_zero(), errors::ZERO_PRIVACY_POOL);
        self.privacy_pool.write(privacy_pool);
    }

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
            // Validate caller is the privacy pool and all inputs are non-zero/non-empty.
            let privacy_pool = self.privacy_pool.read();
            assert(get_caller_address() == privacy_pool, errors::INVALID_CALLER);
            assert(swap_contract.is_non_zero(), errors::ZERO_SWAP_CONTRACT);
            assert(swap_selector.is_non_zero(), errors::ZERO_SWAP_SELECTOR);
            assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN);
            assert(out_token.is_non_zero(), errors::ZERO_OUT_TOKEN);
            assert(in_amount.is_non_zero(), errors::ZERO_AMOUNT);

            let in_erc20 = IERC20Dispatcher { contract_address: in_token };
            let out_erc20 = IERC20Dispatcher { contract_address: out_token };

            let received_amount: u128 = execute_swap(
                :in_erc20, :out_erc20, :swap_contract, :swap_selector, :swap_calldata, :in_amount,
            )
                .try_into()
                .expect(errors::RECEIVED_AMOUNT_OVERFLOW);

            // Approve privacy pool to transfer output tokens.
            if received_amount.is_non_zero() {
                out_erc20.approve(spender: privacy_pool, amount: received_amount.into());
            }

            received_amount
        }

        fn get_privacy_pool(self: @ContractState) -> ContractAddress {
            self.privacy_pool.read()
        }
    }

    /// Approves input tokens, executes swap, and returns the received output amount.
    fn execute_swap(
        in_erc20: IERC20Dispatcher,
        out_erc20: IERC20Dispatcher,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        in_amount: u128,
    ) -> u256 {
        let self_address = get_contract_address();

        // Approve swap contract to spend input tokens.
        in_erc20.approve(spender: swap_contract, amount: in_amount.into());

        // Get output token balance before swap.
        let balance_before = out_erc20.balance_of(account: self_address);

        // Execute swap (propagates error from swap contract if it fails).
        call_contract_syscall(
            address: swap_contract, entry_point_selector: swap_selector, calldata: swap_calldata,
        )
            .unwrap_syscall();

        // Return received amount.
        out_erc20.balance_of(account: self_address) - balance_before
    }
}
