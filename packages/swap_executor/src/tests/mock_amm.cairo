use core::array::Span;

#[starknet::interface]
pub trait IMockAMM<T> {
    fn swap(ref self: T, calldata: Span<felt252>);
    fn get_exchange_rate(self: @T) -> u256;
    fn set_exchange_rate(ref self: T, exchange_rate: u256);
}

/// Mock AMM contract for testing swap functionality.
/// This contract simulates a simple AMM that swaps tokens.
#[starknet::contract]
pub mod MockAMM {
    use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use starkware_utils::erc20::erc20_utils::CheckedIERC20DispatcherTrait;
    use super::IMockAMM;

    #[storage]
    struct Storage {
        /// Exchange rate: output_amount = input_amount * exchange_rate / 1000
        /// For example, exchange_rate = 1000 means 1:1 swap
        exchange_rate: u256,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        SwapExecuted: SwapExecuted,
    }

    #[derive(Drop, starknet::Event)]
    pub struct SwapExecuted {
        pub input_token: ContractAddress,
        pub output_token: ContractAddress,
        pub input_amount: u256,
        pub output_amount: u256,
    }

    #[constructor]
    fn constructor(ref self: ContractState, exchange_rate: u256) {
        self.exchange_rate.write(exchange_rate);
    }

    /// Swaps tokens. Expects calldata: [input_token, output_token, min_output_amount]
    /// Transfers input_token from caller, transfers output_token to caller.
    #[abi(embed_v0)]
    impl MockAMMImpl of IMockAMM<ContractState> {
        fn swap(ref self: ContractState, calldata: Span<felt252>) {
            let caller = get_caller_address();
            let self_address = get_contract_address();

            // Parse calldata: [input_token, output_token, min_output_amount]
            assert(calldata.len() >= 3, 'INVALID_CALLDATA');
            let input_token_felt = *calldata.at(0);
            let output_token_felt = *calldata.at(1);
            let input_token: ContractAddress = input_token_felt.try_into().unwrap();
            let output_token: ContractAddress = output_token_felt.try_into().unwrap();
            let min_output_amount: u256 = (*calldata.at(2)).into();

            // Get input amount from allowance (how much the caller approved us to spend)
            let input_token_dispatcher = IERC20Dispatcher { contract_address: input_token };
            let allowance = input_token_dispatcher.allowance(owner: caller, spender: self_address);
            assert(allowance > 0, 'ZERO_ALLOWANCE');

            // Transfer input tokens from caller to this contract
            input_token_dispatcher
                .checked_transfer_from(sender: caller, recipient: self_address, amount: allowance);

            // Calculate output amount based on exchange rate
            let exchange_rate = self.exchange_rate.read();
            let output_amount = (allowance * exchange_rate) / 1000_u256;
            assert(output_amount >= min_output_amount, 'INSUFFICIENT_OUTPUT');

            // Transfer output tokens to caller
            let output_token_dispatcher = IERC20Dispatcher { contract_address: output_token };
            output_token_dispatcher.checked_transfer(recipient: caller, amount: output_amount);

            // Emit event
            self
                .emit(
                    SwapExecuted {
                        input_token, output_token, input_amount: allowance, output_amount,
                    },
                );
        }

        fn get_exchange_rate(self: @ContractState) -> u256 {
            self.exchange_rate.read()
        }

        fn set_exchange_rate(ref self: ContractState, exchange_rate: u256) {
            self.exchange_rate.write(exchange_rate);
        }
    }
}

