/// A standard-style Starknet account mock that verifies a STARK-curve signature over the passed
/// hash via `check_ecdsa_signature` (like a real SNIP-6 account, which returns `0` on mismatch
/// instead of panicking). Implements no `supports_interface` (SRC5) entrypoint at all, so a call to
/// it reverts with ENTRYPOINT_NOT_FOUND — exercising the pool's safe-dispatcher routing, which
/// must treat the revert as "no custom validation" and fall through to the raw-hash path (case II:
/// tx hash, or case III: SNIP-12 `CallSet` hash) rather than reverting the whole transaction.
#[starknet::contract]
pub mod MockStarkAccount {
    use core::ecdsa::check_ecdsa_signature;
    use privacy::utils::IAccount;
    use starknet::VALIDATED;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        public_key: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: felt252) {
        self.public_key.write(public_key);
    }

    #[abi(embed_v0)]
    impl MockStarkAccountImpl of IAccount<ContractState> {
        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            if signature.len() != 2 {
                return 0;
            }
            let valid = check_ecdsa_signature(
                hash, self.public_key.read(), *signature[0], *signature[1],
            );
            if valid {
                VALIDATED
            } else {
                0
            }
        }
    }
}
