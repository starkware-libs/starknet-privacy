//! Per-swap, per-leg receiver for cross-chain swap proceeds.
//!
//! Deployed lazily by `NearIntentsAnonymizer::finalize` (or `recover`) at a
//! deterministic address computed off-chain by the SDK from a domain-separated
//! salt of the user's `swap_id`. NEAR Intents settlements arrive here as plain
//! ERC-20 transfers (no contract code required at the destination). The
//! `MailboxReceiver` is only deployed at sweep time, with constructor calldata
//! `[anonymizer_address]`. After `sweep`, the contract remains deployed but
//! holds no balance and can never act again (the only state-changing entrypoint
//! is reentrancy-safe and gated to the anonymizer).
use starknet::ContractAddress;

#[starknet::interface]
pub trait IMailboxReceiver<T> {
    /// Transfers the entire `token` balance held by this receiver to the
    /// anonymizer. Returns the swept amount.
    ///
    /// Reverts with `ONLY_ANONYMIZER` if called by anyone other than the
    /// anonymizer address baked in at construction.
    fn sweep(ref self: T, token: ContractAddress) -> u256;
}

pub mod errors {
    pub const ONLY_ANONYMIZER: felt252 = 'MBX_ONLY_ANONYMIZER';
}

#[starknet::contract]
pub mod MailboxReceiver {
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IMailboxReceiver, errors};

    #[storage]
    struct Storage {
        anonymizer: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, anonymizer: ContractAddress) {
        self.anonymizer.write(anonymizer);
    }

    #[abi(embed_v0)]
    pub impl Impl of IMailboxReceiver<ContractState> {
        fn sweep(ref self: ContractState, token: ContractAddress) -> u256 {
            let anonymizer = self.anonymizer.read();
            assert(get_caller_address() == anonymizer, errors::ONLY_ANONYMIZER);
            let erc20 = IERC20Dispatcher { contract_address: token };
            let balance = erc20.balance_of(account: get_contract_address());
            if balance > 0_u256 {
                erc20.transfer(recipient: anonymizer, amount: balance);
            }
            balance
        }
    }
}
