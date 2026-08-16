//! Stand-in for the cemented `Primer` contract (sn-utils `packages/primer`), so tests can exercise
//! the deploy-then-replace flow under this workspace's toolchain. Its class hash therefore differs
//! from the cemented on-chain hash `0x00123e6b…d1d300`.

use starknet::ClassHash;

#[starknet::interface]
pub trait IPrimerMock<T> {
    /// Replaces this contract's class hash, upgrading it into the real implementation. Only the
    /// address that deployed it may call this.
    fn set_class_hash(ref self: T, new_class_hash: ClassHash);
}

#[starknet::contract]
pub mod PrimerMock {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::replace_class_syscall;
    use starknet::{ClassHash, ContractAddress, SyscallResultTrait, get_caller_address};
    use super::IPrimerMock;

    #[storage]
    struct Storage {
        deployer_address: ContractAddress,
    }

    #[constructor]
    pub fn constructor(ref self: ContractState) {
        self.deployer_address.write(get_caller_address());
    }

    #[abi(embed_v0)]
    impl PrimerMockImpl of IPrimerMock<ContractState> {
        fn set_class_hash(ref self: ContractState, new_class_hash: ClassHash) {
            assert(get_caller_address() == self.deployer_address.read(), 'INVALID_CALLER');
            replace_class_syscall(new_class_hash).unwrap_syscall();
        }
    }
}
