use executor_anonymizer::executor_anonymizer::IExecutorAnonymizerDispatcher;
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::{ContractAddress, SyscallResultTrait};

/// The address configured as the privacy contract; the only authorized caller.
pub const PRIVACY: ContractAddress = 'PRIVACY'.try_into().unwrap();

pub fn anonymizer_disp(anonymizer: ContractAddress) -> IExecutorAnonymizerDispatcher {
    IExecutorAnonymizerDispatcher { contract_address: anonymizer }
}

pub fn deploy_executor_anonymizer() -> ContractAddress {
    let executor_class_hash = *declare("SubAccount").unwrap_syscall().contract_class().class_hash;
    let contract = declare("ExecutorAnonymizer").unwrap_syscall().contract_class();
    let (address, _) = contract
        .deploy(@array![PRIVACY.into(), executor_class_hash.into()])
        .unwrap_syscall();
    address
}
