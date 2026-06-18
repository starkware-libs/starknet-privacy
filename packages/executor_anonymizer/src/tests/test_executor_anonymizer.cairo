use core::num::traits::Zero;
use executor_anonymizer::executor_anonymizer::IExecutorAnonymizerDispatcherTrait;
use executor_anonymizer::tests::test_utils::{PRIVACY, anonymizer_disp, deploy_executor_anonymizer};

#[test]
fn test_constructor_sets_privacy_contract() {
    let anonymizer = deploy_executor_anonymizer();
    assert_eq!(anonymizer_disp(anonymizer).get_privacy_contract(), PRIVACY);
}

#[test]
fn test_get_executor_unknown_commitment_is_zero() {
    let anonymizer = deploy_executor_anonymizer();
    assert!(anonymizer_disp(anonymizer).get_executor('UNKNOWN').is_zero());
}
