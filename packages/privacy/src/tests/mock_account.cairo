#[starknet::contract]
pub mod MockAccount {
    use core::num::traits::Zero;
    use privacy::utils::AccountABI;
    use starknet::VALIDATED;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        is_valid: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, is_valid: bool) {
        if is_valid {
            self.is_valid.write(VALIDATED);
        } else {
            self.is_valid.write(Zero::zero());
        }
    }

    #[abi(embed_v0)]
    impl MockAccountImpl of AccountABI<ContractState> {
        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            self.is_valid.read()
        }
    }
}
