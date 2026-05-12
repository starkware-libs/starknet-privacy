//! Day-1 gate: verify our pure-Cairo address-derivation formula matches what
//! `deploy_syscall(deploy_from_zero=false)` actually produces. If this drifts
//! from the OS, the SDK's off-chain mailbox replica would route 1Click funds to
//! dead addresses and the anonymizer would not be able to recover them.

use near_intents_anonymizer::near_intents_anonymizer::{
    INearIntentsAnonymizerDispatcher, INearIntentsAnonymizerDispatcherTrait, compute_address,
    hash_array, output_salt, refund_salt,
};
use near_intents_anonymizer::tests::deploy_probe::{
    IDeployProbeDispatcher, IDeployProbeDispatcherTrait,
};
use snforge_std::{ContractClassTrait, DeclareResultTrait, declare};
use starknet::{ClassHash, ContractAddress};

/// Helper: declare and deploy the anonymizer + receiver class, return both.
fn deploy_anonymizer() -> (INearIntentsAnonymizerDispatcher, ClassHash) {
    let receiver_class = declare("MailboxReceiver").unwrap().contract_class().clone();
    let receiver_class_hash: ClassHash = receiver_class.class_hash;

    let mock_privacy: ContractAddress = 0xdead.try_into().unwrap();
    let mut ctor = array![];
    ctor.append(mock_privacy.into());
    ctor.append(receiver_class_hash.into());

    let anonymizer_class = declare("NearIntentsAnonymizer").unwrap().contract_class().clone();
    let (anonymizer_addr, _) = anonymizer_class.deploy(@ctor).unwrap();

    (INearIntentsAnonymizerDispatcher { contract_address: anonymizer_addr }, receiver_class_hash)
}

#[test]
fn test_output_and_refund_salts_differ_for_same_swap_id() {
    let swap_id: felt252 = 'SWAP_1';
    assert(output_salt(swap_id) != refund_salt(swap_id), 'salts must differ');
}

#[test]
fn test_salts_differ_per_swap_id() {
    assert(output_salt('A') != output_salt('B'), 'output salt collision');
    assert(refund_salt('A') != refund_salt('B'), 'refund salt collision');
}

#[test]
fn test_mailbox_addresses_deterministic() {
    let (anonymizer, _) = deploy_anonymizer();
    let swap_id: felt252 = 'SWAP_1';
    let a = anonymizer.output_mailbox(swap_id);
    let b = anonymizer.output_mailbox(swap_id);
    assert(a == b, 'output mailbox not stable');
    let c = anonymizer.refund_mailbox(swap_id);
    let d = anonymizer.refund_mailbox(swap_id);
    assert(c == d, 'refund mailbox not stable');
}

#[test]
fn test_output_and_refund_mailboxes_differ() {
    let (anonymizer, _) = deploy_anonymizer();
    let swap_id: felt252 = 'SWAP_1';
    let out = anonymizer.output_mailbox(swap_id);
    let refund = anonymizer.refund_mailbox(swap_id);
    assert(out != refund, 'mailboxes must differ');
}

/// **The Day-1 gate.** `compute_address` (our pure-Cairo formula) must match
/// what `deploy_syscall(deploy_from_zero=false)` actually returns. If this
/// drifts, the SDK's off-chain mailbox replica routes 1Click funds to dead
/// addresses and the anonymizer cannot recover them.
#[test]
fn test_compute_address_matches_deploy_syscall() {
    let receiver_class = declare("MailboxReceiver").unwrap().contract_class().clone();
    let receiver_class_hash: ClassHash = receiver_class.class_hash;

    let probe_class = declare("DeployProbe").unwrap().contract_class().clone();
    let (probe_addr, _) = probe_class.deploy(@array![]).unwrap();
    let probe = IDeployProbeDispatcher { contract_address: probe_addr };

    // Cover a few salts: structural ones + an arbitrary user-shaped one.
    let salts: Array<felt252> = array![1, 0xdeadbeef, 'TEST_SWAP_ID_1', 0x123456789abcdef];
    for salt in salts.span() {
        let actual = probe.deploy_mailbox(class_hash: receiver_class_hash, salt: *salt);

        let probe_addr_felt: felt252 = probe_addr.into();
        let ctor_hash = hash_array(array![probe_addr_felt].span());
        let expected = compute_address(
            deployer: probe_addr,
            class_hash: receiver_class_hash,
            salt: *salt,
            ctor_hash: ctor_hash,
        );

        assert(actual == expected, 'formula != deploy_syscall');
    };
}

#[test]
fn test_mailboxes_unique_per_swap_id() {
    let (anonymizer, _) = deploy_anonymizer();
    let m1 = anonymizer.output_mailbox('A');
    let m2 = anonymizer.output_mailbox('B');
    assert(m1 != m2, 'output not unique');
    let r1 = anonymizer.refund_mailbox('A');
    let r2 = anonymizer.refund_mailbox('B');
    assert(r1 != r2, 'refund not unique');
}
