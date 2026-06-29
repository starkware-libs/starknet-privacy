//! Minimal dapp used to exercise sub_account-driven interactions: `transfer_to_caller` transfers a
//! previously funded token balance to whoever calls it (the sub_account), modelling a dapp that
//! returns funds to the calling account.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockDapp<T> {
    /// Transfers `amount` of `token` from this contract to the caller.
    fn transfer_to_caller(ref self: T, token: ContractAddress, amount: u256);
}

#[starknet::contract]
pub mod MockDapp {
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::{ContractAddress, get_caller_address};
    use super::IMockDapp;

    #[storage]
    struct Storage {}

    #[abi(embed_v0)]
    impl MockDappImpl of IMockDapp<ContractState> {
        fn transfer_to_caller(ref self: ContractState, token: ContractAddress, amount: u256) {
            IERC20Dispatcher { contract_address: token }
                .transfer(recipient: get_caller_address(), :amount);
        }
    }
}
