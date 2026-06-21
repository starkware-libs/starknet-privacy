//! Mock contract used to test the apply_actions reentrancy lock.
//!
//! When invoked by the privacy contract via an Invoke action, it attempts to call
//! `apply_actions` on the privacy contract again. That reentrant call must be rejected
//! by the ReentrancyGuard component.

#[starknet::interface]
pub trait IReentrancyMock<T> {
    /// Called by the privacy contract via INVOKE_SELECTOR. Attempts to call
    /// `apply_actions` on the caller (privacy contract) with empty actions.
    fn privacy_invoke(ref self: T);
    /// Called by the privacy contract via INVOKE_WITH_COMPUTATION_SELECTOR. Attempts to call
    /// `apply_actions` on the caller (privacy contract) with empty actions.
    fn privacy_invoke_with_computation(ref self: T);
    /// Called by the privacy contract via PRIVACY_COMPUTE_SELECTOR during `__execute__` (client
    /// side). Attempts to reenter `apply_actions` on the caller (privacy contract) with empty
    /// actions.
    fn privacy_compute(ref self: T, identity_key: felt252) -> felt252;
}

#[starknet::contract]
pub mod MockReentrancy {
    use privacy::interface::{IServerDispatcher, IServerDispatcherTrait};
    use starknet::get_caller_address;
    use super::IReentrancyMock;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    impl ReentrancyMockImpl of IReentrancyMock<ContractState> {
        fn privacy_invoke(ref self: ContractState) {
            call_apply_actions();
        }

        fn privacy_invoke_with_computation(ref self: ContractState) {
            call_apply_actions();
        }

        fn privacy_compute(ref self: ContractState, identity_key: felt252) -> felt252 {
            call_apply_actions();
            identity_key
        }
    }

    fn call_apply_actions() {
        let privacy_addr = get_caller_address();
        IServerDispatcher { contract_address: privacy_addr }.apply_actions([].span(), None);
    }
}
