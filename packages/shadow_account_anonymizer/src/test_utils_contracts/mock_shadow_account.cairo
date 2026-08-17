//! A second [`IShadowAccount`](starkware_accounts::shadow_account::IShadowAccount) implementation,
//! behaviourally equivalent to
//! [`ShadowAccount`](starkware_accounts::shadow_account::ShadowAccount) but a distinct class.
//!
//! It exists for tests that require a different (class-hash wise) shadow account implementation.

#[starknet::contract]
pub mod MockShadowAccount {
    use core::num::traits::Zero;
    use openzeppelin::utils::execution::execute_calls;
    use starknet::account::Call;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use starkware_accounts::shadow_account::IShadowAccount;

    #[storage]
    struct Storage {
        owner: ContractAddress,
    }

    #[abi(embed_v0)]
    impl MockShadowAccountImpl of IShadowAccount<ContractState> {
        fn execute(ref self: ContractState, calls: Array<Call>) -> Array<Span<felt252>> {
            assert(get_caller_address() == self.owner.read(), 'SHADOW_ACCOUNT: NOT OWNER');
            execute_calls(calls.span())
        }

        fn initialize(ref self: ContractState) {
            assert(self.owner.read().is_zero(), 'SHADOW_ACCOUNT: INITIALIZED');
            self.owner.write(get_caller_address());
        }

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }
    }
}
