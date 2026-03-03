use privacy::objects::DepositToOpenNoteInput;
use starknet::ContractAddress;

#[starknet::interface]
pub trait ISwapExecutor<T> {
    /// Executes a swap on an external AMM/DEX and deposits the result to an open note.
    ///
    /// Can be called by the privacy contract via the
    /// [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR) selector.
    ///
    /// #### Parameters
    /// - `in_token` (`ContractAddress`) - The token address of the input funds.
    /// - `out_token` (`ContractAddress`) - The token address of the output funds.
    /// - `in_amount` (`u128`) - The amount of input funds to swap.
    /// - `note_id` (`felt252`) - The identifier of the open note to deposit the output to.
    ///
    /// #### Returns
    /// A span of `DepositToOpenNoteInput` for the privacy contract to apply.
    ///
    /// #### Preconditions
    /// - The swap executor must have sufficient input token balance.
    /// - The caller must be the privacy contract that owns the open note.
    /// - The open note must exist and be ready to receive deposits.
    ///
    /// #### Flow
    /// 1. Approves swap contract to spend `in_amount` of in tokens.
    /// 2. Records output token balance, executes the swap, calculates received amount.
    /// 3. Approves the caller (privacy contract) to transfer the received output funds.
    /// 4. Returns a span of `DepositToOpenNoteInput` for the privacy contract to apply.
    fn privacy_invoke(
        ref self: T,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
        note_id: felt252,
    ) -> Span<DepositToOpenNoteInput>;
}

pub mod errors {
    pub const ZERO_IN_TOKEN: felt252 = 'ZERO_IN_TOKEN';
    pub const ZERO_OUT_TOKEN: felt252 = 'ZERO_OUT_TOKEN';
    pub const ZERO_IN_AMOUNT: felt252 = 'ZERO_IN_AMOUNT';
    pub const IN_TOKEN_EQUAL_TO_OUT_TOKEN: felt252 = 'IN_TOKEN_EQUAL_TO_OUT_TOKEN';
    pub const INSUFFICIENT_BALANCE: felt252 = 'INSUFFICIENT_BALANCE';
    pub const ZERO_AMM_ADDRESS: felt252 = 'ZERO_AMM_ADDRESS';
    pub const ZERO_SELECTOR: felt252 = 'ZERO_SELECTOR';
    pub const RECEIVED_AMOUNT_OVERFLOW: felt252 = 'RECEIVED_AMOUNT_OVERFLOW';
    pub const ZERO_OUT_AMOUNT: felt252 = 'ZERO_OUT_AMOUNT';
}

#[starknet::contract]
pub mod MockSwapExecutor {
    use core::num::traits::Zero;
    use openzeppelin::interfaces::token::erc20::{IERC20Dispatcher, IERC20DispatcherTrait};
    use privacy::objects::DepositToOpenNoteInput;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_caller_address, get_contract_address};
    use super::{ISwapExecutor, errors};

    #[storage]
    struct Storage {
        amm_address: ContractAddress,
        selector: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, amm_address: ContractAddress, selector: felt252) {
        assert(amm_address.is_non_zero(), errors::ZERO_AMM_ADDRESS);
        assert(selector.is_non_zero(), errors::ZERO_SELECTOR);
        self.amm_address.write(amm_address);
        self.selector.write(selector);
    }

    #[abi(embed_v0)]
    pub impl SwapExecutorImpl of ISwapExecutor<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            in_token: ContractAddress,
            out_token: ContractAddress,
            in_amount: u128,
            note_id: felt252,
        ) -> Span<DepositToOpenNoteInput> {
            assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN);
            assert(out_token.is_non_zero(), errors::ZERO_OUT_TOKEN);
            assert(in_amount.is_non_zero(), errors::ZERO_IN_AMOUNT);
            assert(in_token != out_token, errors::IN_TOKEN_EQUAL_TO_OUT_TOKEN);

            let self_addr = get_contract_address();
            let privacy_addr = get_caller_address();
            let in_erc20 = IERC20Dispatcher { contract_address: in_token };
            let out_erc20 = IERC20Dispatcher { contract_address: out_token };

            // Approve AMM to spend `in_amount` of `in_token`.
            assert(
                in_erc20.balance_of(account: self_addr) >= in_amount.into(),
                errors::INSUFFICIENT_BALANCE,
            );
            let amm_address = self.amm_address.read();
            in_erc20.approve(spender: amm_address, amount: in_amount.into());

            // Get output token balance before swap.
            let balance_before = out_erc20.balance_of(account: self_addr);

            // Execute swap (propagates error from AMM if it fails).
            call_contract_syscall(
                address: amm_address,
                entry_point_selector: self.selector.read(),
                calldata: [in_token.into(), out_token.into(), in_amount.into(), 0].span(),
            )
                .unwrap_syscall();

            // Calculate output amount.
            let balance_after = out_erc20.balance_of(account: self_addr);
            let out_amount: u128 = (balance_after - balance_before)
                .try_into()
                .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
            assert(out_amount.is_non_zero(), errors::ZERO_OUT_AMOUNT);

            // Approve caller (privacy contract) to transfer received output funds.
            out_erc20.approve(spender: privacy_addr, amount: out_amount.into());

            // Deposit to the open note on the privacy contract.
            let depositor = get_contract_address();
            [DepositToOpenNoteInput { note_id, depositor, token: out_token, amount: out_amount }]
                .span()
        }
    }
}
