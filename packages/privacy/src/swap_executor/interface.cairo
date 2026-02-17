use starknet::ContractAddress;

#[starknet::interface]
pub trait ISwapExecutor<T> {
    // TODO: Revise after refactor.
    /// Executes a swap on an external AMM/DEX and deposits the result to an open note.
    ///
    /// Called by the privacy contract via the
    /// [`INVOKE_SELECTOR`](privacy::utils::constants::INVOKE_SELECTOR) selector.
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
    /// None
    ///
    /// #### Preconditions
    /// - Assumes all parameters are non-zero.
    /// - The swap executor must have sufficient input token balance.
    /// - The caller must be the privacy contract that owns the open note.
    /// - The open note must exist and be ready to receive deposits.
    ///
    /// #### Flow
    /// 1. Approves swap contract to spend `in_amount` of in tokens.
    /// 2. Records output token balance, executes the swap, calculates received amount.
    /// 3. Approves the caller (privacy contract) to transfer the received output funds.
    /// 4. Calls `deposit_to_open_note` on the caller with `note_id` and the received amount.
    fn privacy_invoke(
        ref self: T,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
        note_id: felt252,
    );
}
