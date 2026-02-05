use starknet::ContractAddress;

#[starknet::interface]
pub trait ISwapExecutor<T> {
    /// Executes a swap on an external AMM/DEX and deposits the result to an open note.
    ///
    /// Executes a swap operation on an external AMM/DEX contract, then deposits the received
    /// output tokens to an open note on the caller (privacy contract).
    ///
    /// #### Parameters
    /// - `swap_contract` (`ContractAddress`) - The AMM/DEX contract to call for the swap.
    /// - `swap_selector` (`felt252`) - The selector of the swap function to call.
    /// - `swap_calldata` (`Span<felt252>`) - The calldata for the swap function.
    /// - `in_token` (`ContractAddress`) - The token address of the input funds.
    /// - `out_token` (`ContractAddress`) - The token address of the output funds.
    /// - `in_amount` (`u128`) - The amount of input funds to swap.
    /// - `note_id` (`felt252`) - The identifier of the open note to deposit the output to.
    ///
    /// #### Returns
    /// - (`u128`) - The amount of output funds received from the swap.
    ///
    /// #### Preconditions
    /// - All parameters must be non-zero.
    /// - The swap executor must have sufficient input token balance.
    /// - The caller must be the privacy contract that owns the open note.
    /// - The open note must exist and be ready to receive deposits.
    ///
    /// #### Flow
    /// 1. Validates all inputs are valid.
    /// 2. Approves swap contract to spend `in_amount` of in tokens.
    /// 3. Records output token balance, executes the swap, calculates received amount.
    /// 4. Approves the caller (privacy contract) to transfer the received output funds.
    /// 5. Calls `deposit_to_open_note` on the caller with `note_id` and the received amount.
    /// 6. Returns the received amount.
    fn swap(
        ref self: T,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
        note_id: felt252,
    ) -> u128;
}
