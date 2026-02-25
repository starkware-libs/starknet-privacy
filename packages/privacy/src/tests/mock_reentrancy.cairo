//! Mock contract used to test the apply_actions reentrancy lock.
//!
//! When invoked by the privacy contract via an Invoke action, it attempts to call
//! `apply_actions` on the privacy contract again. That reentrant call must be rejected
//! with APPLY_ACTIONS_LOCKED.

#[starknet::interface]
pub trait IReentrancyMock<T> {
    /// Called by the privacy contract via INVOKE_SELECTOR. Attempts to call
    /// `apply_actions` on the caller (privacy contract) with empty actions.
    fn privacy_invoke(ref self: T);
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
            let privacy_addr = get_caller_address();
            IServerDispatcher { contract_address: privacy_addr }.apply_actions([].span());
        }
    }
}
