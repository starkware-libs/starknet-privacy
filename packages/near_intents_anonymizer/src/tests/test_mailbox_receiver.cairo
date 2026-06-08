//! Direct unit tests for `MailboxReceiver`. The contract is so small that
//! these are mostly belt-and-suspenders: confirm the caller check fires and
//! a zero-balance sweep is a no-op rather than a revert.

use near_intents_anonymizer::mailbox_receiver::{
    IMailboxReceiverDispatcher, IMailboxReceiverDispatcherTrait,
};
use near_intents_anonymizer::tests::test_utils::{
    DEFAULT_AMOUNT, alice, bob, deploy_test_erc20, erc20, fund,
};
use openzeppelin::interfaces::token::erc20::IERC20DispatcherTrait;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;

fn deploy_receiver(anonymizer: ContractAddress) -> IMailboxReceiverDispatcher {
    let class = declare("MailboxReceiver").unwrap().contract_class().clone();
    let mut ctor = array![];
    ctor.append(anonymizer.into());
    let (addr, _) = class.deploy(@ctor).unwrap();
    IMailboxReceiverDispatcher { contract_address: addr }
}

#[test]
fn test_sweep_drains_to_anonymizer() {
    let anonymizer = alice();
    let receiver = deploy_receiver(anonymizer);
    let token = deploy_test_erc20();
    fund(token, receiver.contract_address, DEFAULT_AMOUNT);

    start_cheat_caller_address(receiver.contract_address, anonymizer);
    let swept = receiver.sweep(token.address);
    stop_cheat_caller_address(receiver.contract_address);

    assert(swept == DEFAULT_AMOUNT.into(), 'wrong swept amount');
    let token_erc20 = erc20(token);
    assert(
        token_erc20.balance_of(receiver.contract_address) == 0_u256, 'receiver not drained',
    );
    assert(
        token_erc20.balance_of(anonymizer) == DEFAULT_AMOUNT.into(),
        'anonymizer not credited',
    );
}

#[test]
fn test_sweep_zero_balance_is_noop() {
    let anonymizer = alice();
    let receiver = deploy_receiver(anonymizer);
    let token = deploy_test_erc20();
    // Don't fund the receiver.

    start_cheat_caller_address(receiver.contract_address, anonymizer);
    let swept = receiver.sweep(token.address);
    stop_cheat_caller_address(receiver.contract_address);

    assert(swept == 0_u256, 'should return 0');
}

#[test]
#[should_panic(expected: 'MBX_ONLY_ANONYMIZER')]
fn test_only_anonymizer_can_sweep() {
    let anonymizer = alice();
    let receiver = deploy_receiver(anonymizer);
    let token = deploy_test_erc20();
    fund(token, receiver.contract_address, DEFAULT_AMOUNT);

    // Bob is not the anonymizer; this must revert.
    start_cheat_caller_address(receiver.contract_address, bob());
    receiver.sweep(token.address);
    stop_cheat_caller_address(receiver.contract_address);
}
