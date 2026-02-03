use starknet::ContractAddress;

/// Interface for the mock AMM.
#[starknet::interface]
pub trait IMockAMM<T> {
    fn swap(ref self: T, in_token: ContractAddress, out_token: ContractAddress, amount: u256);

    /// Does nothing - used to test zero received amount scenario.
    fn noop_swap(ref self: T, _ignored: felt252);

    /// Always panics with 'SWAP_FAILED' - used to test error propagation.
    fn failing_swap(ref self: T, _ignored: felt252);

    /// Returns an amount exceeding u128::MAX - used to test overflow error.
    fn overflow_swap(ref self: T, out_token: ContractAddress);
}

/// Mock AMM contract for testing swap functionality.
/// Implements a simple 1:1 swap.
#[starknet::contract]
pub mod MockAMM {
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use starkware_utils::constants::MAX_U128;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl MockAMMImpl of super::IMockAMM<ContractState> {
        fn swap(
            ref self: ContractState,
            in_token: ContractAddress,
            out_token: ContractAddress,
            amount: u256,
        ) {
            let caller = get_caller_address();

            // Transfer input tokens from caller.
            IERC20Dispatcher { contract_address: in_token }
                .transfer_from(sender: caller, recipient: get_contract_address(), :amount);

            // Transfer output tokens (1:1 exchange).
            IERC20Dispatcher { contract_address: out_token }.transfer(recipient: caller, :amount);
        }

        fn noop_swap(
            ref self: ContractState, _ignored: felt252,
        ) { // Does nothing - simulates a swap that returns 0 tokens.
        }

        fn failing_swap(ref self: ContractState, _ignored: felt252) {
            assert(false, 'SWAP_FAILED');
        }

        fn overflow_swap(ref self: ContractState, out_token: ContractAddress) {
            // Transfer an amount exceeding MAX_U128 to caller.
            let overflow_amount: u256 = MAX_U128.into() + 1;
            IERC20Dispatcher { contract_address: out_token }
                .transfer(recipient: get_caller_address(), amount: overflow_amount);
        }
    }
}
