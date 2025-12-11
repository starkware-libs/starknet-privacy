use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use server::errors;
use starknet::{ContractAddress, get_contract_address};

pub(crate) fn claim_funds(owner: ContractAddress, token: ContractAddress, amount: u256) {
    let contract_address = get_contract_address();
    let token_dispatcher = IERC20Dispatcher { contract_address: token };

    let allowance = token_dispatcher.allowance(:owner, spender: contract_address);
    assert(allowance >= amount, errors::INSUFFICIENT_ALLOWANCE);
    let balance = token_dispatcher.balance_of(account: owner);
    assert(balance >= amount, errors::INSUFFICIENT_BALANCE);

    token_dispatcher.transfer_from(sender: owner, recipient: contract_address, :amount);
}
