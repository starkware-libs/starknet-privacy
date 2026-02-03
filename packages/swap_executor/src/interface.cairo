use starknet::ContractAddress;

#[starknet::interface]
pub trait ISwapExecutor<T> {
    /// Executes a swap and deposits the resulting tokens into an open note in the privacy pool.
    ///
    /// This function can only be called by the privacy pool contract. It executes a swap
    /// operation on an external AMM/DEX contract and then deposits the resulting tokens
    /// into an open note using the `DepositToOpenNote` server action.
    ///
    /// #### Parameters
    /// - `swap_contract` (`ContractAddress`) - The AMM/DEX contract to call for the swap.
    /// - `swap_selector` (`felt252`) - The selector of the swap function to call.
    /// - `swap_calldata` (`Span<felt252>`) - The calldata for the swap function.
    /// - `input_token` (`ContractAddress`) - The input token address to approve for the swap.
    /// - `output_token` (`ContractAddress`) - The output token address (used to measure received
    ///   amount).
    /// - `amount` (`u128`) - The input amount to approve for the swap.
    /// - `note_id` (`felt252`) - The open note id to deposit into.
    ///
    /// #### Preconditions
    /// - Caller must be the privacy pool contract.
    /// - All parameters must be non-zero/non-empty.
    /// - The open note must exist with the swap executor as the depositor.
    /// - The swap executor must have sufficient input token balance.
    ///
    /// #### Flow
    /// 1. Validates caller is the privacy pool and all inputs are valid.
    /// 2. Approves swap contract to spend `amount` of input tokens.
    /// 3. Records output token balance, executes the swap, calculates received amount.
    /// 4. If tokens were received: approves privacy pool and calls
    ///    `execute_actions([DepositToOpenNote])` with the received amount.
    fn swap_and_deposit(
        ref self: T,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        input_token: ContractAddress,
        output_token: ContractAddress,
        amount: u128,
        note_id: felt252,
    );

    /// Returns the address of the privacy pool contract.
    fn get_privacy_pool(self: @T) -> ContractAddress;
}
