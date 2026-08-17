/// A standard-style Starknet account mock that verifies a STARK-curve signature over the passed
/// hash via `check_ecdsa_signature` (like a real SNIP-6 account, which returns `0` on mismatch
/// instead of panicking). Implements no `supports_interface` (SRC5) entrypoint at all, so a call to
/// it reverts with ENTRYPOINT_NOT_FOUND — exercising the pool's safe-dispatcher routing, which
/// must treat the revert as "no custom validation" and fall through to the raw-hash path (case II:
/// tx hash, or case III: SNIP-12 `CallSet` hash) rather than reverting the whole transaction.
#[starknet::contract]
pub mod MockStarkAccount {
    use core::ecdsa::check_ecdsa_signature;
    use core::panic_with_felt252;
    use privacy::utils::IAccount;
    use privacy::utils::constants::LEGACY_VALIDATED;
    use starknet::VALIDATED;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    pub const INVALID_SIG: felt252 = 'INVALID_SIG';

    #[storage]
    struct Storage {
        public_key: felt252,
        // Whether acceptance is reported as a pre-SNIP-6 boolean instead of `VALIDATED`.
        returns_legacy_bool: bool,
        // Whether rejection is reported by panicking instead of returning 0.
        panics_on_reject: bool,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        public_key: felt252,
        returns_legacy_bool: bool,
        panics_on_reject: bool,
    ) {
        self.public_key.write(public_key);
        self.returns_legacy_bool.write(returns_legacy_bool);
        self.panics_on_reject.write(panics_on_reject);
    }

    #[abi(embed_v0)]
    impl MockStarkAccountImpl of IAccount<ContractState> {
        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            let valid = if signature.len() != 2 {
                false
            } else {
                check_ecdsa_signature(hash, self.public_key.read(), *signature[0], *signature[1])
            };
            if !valid {
                if self.panics_on_reject.read() {
                    panic_with_felt252(INVALID_SIG);
                }
                return 0;
            }
            if self.returns_legacy_bool.read() {
                LEGACY_VALIDATED
            } else {
                VALIDATED
            }
        }
    }
}
