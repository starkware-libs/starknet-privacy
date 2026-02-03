#[starknet::contract]
pub mod SwapExecutor {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::actions::{DepositToOpenNoteInput, ServerAction};
    use privacy::interface::{IServerDispatcher, IServerDispatcherTrait};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address};
    use swap_executor::errors;
    use swap_executor::interface::ISwapExecutor;

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
        fn swap_and_deposit(
            ref self: ContractState,
            swap_contract: ContractAddress,
            swap_selector: felt252,
            swap_calldata: Span<felt252>,
            input_token: ContractAddress,
            output_token: ContractAddress,
            amount: u128,
            note_id: felt252,
        ) {
            // Validate caller is the privacy pool and all inputs are non-zero/non-empty.
            let privacy_pool = self.privacy_pool.read();
            assert(get_caller_address() == privacy_pool, errors::INVALID_CALLER);
            assert(swap_contract.is_non_zero(), errors::ZERO_SWAP_CONTRACT);
            assert(swap_selector.is_non_zero(), errors::ZERO_SWAP_SELECTOR);
            assert(!swap_calldata.is_empty(), errors::EMPTY_SWAP_CALLDATA);
            assert(input_token.is_non_zero(), errors::ZERO_INPUT_TOKEN);
            assert(output_token.is_non_zero(), errors::ZERO_OUTPUT_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(note_id.is_non_zero(), errors::ZERO_NOTE_ID);

            let input_token_dispatcher = IERC20Dispatcher { contract_address: input_token };
            let output_token_dispatcher = IERC20Dispatcher { contract_address: output_token };

            let received_amount: u128 = execute_swap(
                :input_token_dispatcher,
                :output_token_dispatcher,
                :swap_contract,
                :swap_selector,
                :swap_calldata,
                :amount,
            )
                .try_into()
                .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
            if received_amount > 0 {
                deposit_to_open_note(
                    :privacy_pool, :output_token_dispatcher, amount: received_amount, :note_id,
                );
            }
        }

        fn get_privacy_pool(self: @ContractState) -> ContractAddress {
            self.privacy_pool.read()
        }
    }

    /// Approves input tokens, executes swap, and returns the received output amount.
    fn execute_swap(
        input_token_dispatcher: IERC20Dispatcher,
        output_token_dispatcher: IERC20Dispatcher,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        amount: u128,
    ) -> u256 {
        let self_address = get_contract_address();

        // Approve swap contract to spend input tokens.
        input_token_dispatcher.approve(spender: swap_contract, amount: amount.into());

        // Get output token balance before swap.
        let balance_before = output_token_dispatcher.balance_of(account: self_address);

        // Execute swap (propagates error from swap contract if it fails).
        call_contract_syscall(
            address: swap_contract, entry_point_selector: swap_selector, calldata: swap_calldata,
        )
            .unwrap_syscall();

        // Return received amount.
        output_token_dispatcher.balance_of(account: self_address) - balance_before
    }

    /// Approves and deposits received tokens to an open note in the privacy pool.
    fn deposit_to_open_note(
        privacy_pool: ContractAddress,
        output_token_dispatcher: IERC20Dispatcher,
        amount: u128,
        note_id: felt252,
    ) {
        // Approve privacy pool to transfer output tokens.
        output_token_dispatcher.approve(spender: privacy_pool, amount: amount.into());

        // Deposit to open note.
        IServerDispatcher { contract_address: privacy_pool }
            .execute_actions(
                [ServerAction::DepositToOpenNote(DepositToOpenNoteInput { note_id, amount }),]
                    .span(),
            );
    }
}
