use starknet::ContractAddress;

/// Denominator for exchange rate calculation.
pub const RATE_DENOMINATOR: u256 = 1000;

/// Interface for the mock AMM.
#[starknet::interface]
pub trait IMockAMM<T> {
    fn swap(ref self: T, input_token: ContractAddress, output_token: ContractAddress);

    /// Does nothing - used to test zero received amount scenario.
    fn noop_swap(ref self: T, _ignored: felt252);

    /// Always panics with 'SWAP_FAILED' - used to test error propagation.
    fn failing_swap(ref self: T, _ignored: felt252);

    /// Returns an amount exceeding u128::MAX - used to test overflow error.
    fn overflow_swap(ref self: T, output_token: ContractAddress);
}

/// Mock AMM contract for testing swap functionality.
/// Implements a simple swap with configurable exchange rate.
#[starknet::contract]
pub mod MockAMM {
    use core::num::traits::Bounded;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};

    #[storage]
    struct Storage {
        /// Exchange rate multiplier (rate / RATE_DENOMINATOR).
        /// e.g., RATE_DENOMINATOR = 1:1, RATE_DENOMINATOR/2 = 0.5:1, RATE_DENOMINATOR*2 = 2:1
        exchange_rate: u256,
    }

    #[constructor]
    fn constructor(ref self: ContractState, exchange_rate: u256) {
        self.exchange_rate.write(exchange_rate);
    }

    #[abi(embed_v0)]
    impl MockAMMImpl of super::IMockAMM<ContractState> {
        fn swap(
            ref self: ContractState, input_token: ContractAddress, output_token: ContractAddress,
        ) {
            let caller = get_caller_address();
            let self_address = get_contract_address();

            // Transfer input tokens from caller based on allowance.
            let input_dispatcher = IERC20Dispatcher { contract_address: input_token };
            let input_amount = input_dispatcher.allowance(owner: caller, spender: self_address);
            input_dispatcher
                .transfer_from(sender: caller, recipient: self_address, amount: input_amount);

            // Transfer output tokens based on exchange rate.
            let output_amount = (input_amount * self.exchange_rate.read())
                / super::RATE_DENOMINATOR;
            IERC20Dispatcher { contract_address: output_token }
                .transfer(recipient: caller, amount: output_amount);
        }

        fn noop_swap(
            ref self: ContractState, _ignored: felt252,
        ) { // Does nothing - simulates a swap that returns 0 tokens.
        }

        fn failing_swap(ref self: ContractState, _ignored: felt252) {
            assert(false, 'SWAP_FAILED');
        }

        fn overflow_swap(ref self: ContractState, output_token: ContractAddress) {
            // Transfer an amount exceeding u128::MAX to caller.
            let overflow_amount: u256 = Bounded::<u128>::MAX.into() + 1;
            IERC20Dispatcher { contract_address: output_token }
                .transfer(recipient: get_caller_address(), amount: overflow_amount);
        }
    }
}
