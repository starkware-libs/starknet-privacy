/// An account mock that rejects a mismatched signature by *panicking* instead of returning `0`,
#[starknet::contract]
pub mod MockAssertingAccount {
    use core::ecdsa::check_ecdsa_signature;
    use privacy::utils::IAccount;
    use starknet::VALIDATED;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    
    pub const INVALID_SIG: felt252 = 'INVALID_SIG';

    #[storage]
    struct Storage {
        public_key: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: felt252) {
        self.public_key.write(public_key);
    }

    #[abi(embed_v0)]
    impl MockAssertingAccountImpl of IAccount<ContractState> {
        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            assert(signature.len() == 2, INVALID_SIG);
            assert(
                check_ecdsa_signature(
                    message_hash: hash,
                    public_key: self.public_key.read(),
                    signature_r: *signature[0],
                    signature_s: *signature[1],
                ),
                INVALID_SIG,
            );
            VALIDATED
        }
    }
}
