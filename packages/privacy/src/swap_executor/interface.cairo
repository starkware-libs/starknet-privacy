use starknet::ContractAddress;

#[starknet::interface]
pub trait ISwapExecutor<T> {
    /// Executes a swap on an external AMM/DEX and approves the caller to pull the result.
    ///
    /// Executes a swap operation on an external AMM/DEX contract, approves the caller to transfer
    /// the received funds, and returns the received amount.
    ///
    /// #### Parameters
    /// - `swap_contract` (`ContractAddress`) - The AMM/DEX contract to call for the swap.
    /// - `swap_selector` (`felt252`) - The selector of the swap function to call.
    /// - `swap_calldata` (`Span<felt252>`) - The calldata for the swap function.
    /// - `in_token` (`ContractAddress`) - The input token address to approve for the swap.
    /// - `out_token` (`ContractAddress`) - The output token address (used to measure received
    ///   amount).
    /// - `in_amount` (`u128`) - The input amount to approve for the swap.
    ///
    /// #### Returns
    /// - `u128` - The amount of output funds received from the swap.
    ///
    /// #### Preconditions
    /// - All parameters must be non-zero.
    /// - The swap executor must have sufficient input token balance.
    ///
    /// #### Flow
    /// 1. Validates all inputs are valid.
    /// 2. Approves swap contract to spend `in_amount` of in tokens.
    /// 3. Records output token balance, executes the swap, calculates received amount.
    /// 4. Approves caller to transfer the received output tokens.
    /// 5. Returns the received amount.
    fn swap(
        ref self: T,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
    ) -> u128;
}
