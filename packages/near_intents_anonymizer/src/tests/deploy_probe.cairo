//! Test-only probe contract that exercises `deploy_syscall` with the same
//! `(class_hash, salt, [self_address], deploy_from_zero=false)` shape the
//! anonymizer uses, so tests can compare the syscall's returned address
//! against our pure-Cairo `compute_address` formula.

use starknet::{ClassHash, ContractAddress};

#[starknet::interface]
pub trait IDeployProbe<T> {
    /// Deploys a `MailboxReceiver` (class_hash) at salt with constructor
    /// calldata `[self.contract_address]` and returns the resulting address.
    /// Matches the anonymizer's behavior exactly.
    fn deploy_mailbox(ref self: T, class_hash: ClassHash, salt: felt252) -> ContractAddress;
}

#[starknet::contract]
pub mod DeployProbe {
    use starknet::syscalls::deploy_syscall;
    use starknet::{ClassHash, ContractAddress, SyscallResultTrait, get_contract_address};
    use super::IDeployProbe;

    #[storage]
    struct Storage {}

    #[abi(embed_v0)]
    pub impl Impl of IDeployProbe<ContractState> {
        fn deploy_mailbox(
            ref self: ContractState, class_hash: ClassHash, salt: felt252,
        ) -> ContractAddress {
            let self_addr_felt: felt252 = get_contract_address().into();
            let calldata = array![self_addr_felt];
            let (deployed, _) = deploy_syscall(
                class_hash,
                contract_address_salt: salt,
                calldata: calldata.span(),
                deploy_from_zero: false,
            )
                .unwrap_syscall();
            deployed
        }
    }
}
