use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use snforge_std::{DeclareResultTrait, declare};
use starknet::SyscallResultTrait;
use sub_account_anonymizer::sub_account_anonymizer::ISubAccountAnonymizerDispatcherTrait;
use sub_account_anonymizer::tests::test_utils::{
    PRIVACY, anonymizer_disp, deploy_sub_account_anonymizer,
};

#[test]
fn test_privacy_compute_matches_poseidon() {
    let anonymizer = deploy_sub_account_anonymizer();
    let commitment = anonymizer_disp(anonymizer).privacy_compute('USER', 'DAPP', 7);
    assert_eq!(commitment, poseidon_hash_span(['USER', 'DAPP', 7].span()));
}

#[test]
fn test_get_privacy_contract() {
    let anonymizer = deploy_sub_account_anonymizer();
    assert_eq!(anonymizer_disp(anonymizer).get_privacy_contract(), PRIVACY);
}

#[test]
fn test_get_sub_account_class_hash() {
    let anonymizer = deploy_sub_account_anonymizer();
    let expected = *declare("SubAccount").unwrap_syscall().contract_class().class_hash;
    assert_eq!(anonymizer_disp(anonymizer).get_sub_account_class_hash(), expected);
}

#[test]
fn test_get_sub_account_unknown_commitment_is_zero() {
    let anonymizer = deploy_sub_account_anonymizer();
    assert!(anonymizer_disp(anonymizer).get_sub_account('UNKNOWN').is_zero());
}
