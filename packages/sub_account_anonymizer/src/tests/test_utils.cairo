use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::{ContractAddress, SyscallResultTrait};
use sub_account_anonymizer::sub_account_anonymizer::ISubAccountAnonymizerDispatcher;

/// The address configured as the privacy contract; the only authorized caller.
pub const PRIVACY: ContractAddress = 'PRIVACY'.try_into().unwrap();

pub fn anonymizer_disp(anonymizer: ContractAddress) -> ISubAccountAnonymizerDispatcher {
    ISubAccountAnonymizerDispatcher { contract_address: anonymizer }
}

pub fn deploy_sub_account_anonymizer() -> ContractAddress {
    let sub_account_class_hash = *declare("SubAccount")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let contract = declare("SubAccountAnonymizer").unwrap_syscall().contract_class();
    let (address, _) = contract
        .deploy(@array![PRIVACY.into(), sub_account_class_hash.into()])
        .unwrap_syscall();
    address
}
