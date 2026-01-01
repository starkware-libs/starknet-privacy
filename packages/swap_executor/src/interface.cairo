use core::array::Span;
use starknet::ContractAddress;

#[starknet::interface]
pub trait ISwapExecutor<T> {
    /// Executes a swap function call and deposits the resulting tokens into the privacy pool.
    ///
    /// This function can only be called by the privacy pool contract. It executes a swap
    /// operation on an external contract and then deposits the resulting tokens.
    ///
    /// #### Parameters
    /// - `swap_contract` (`ContractAddress`) - The address of the contract to call for the swap.
    /// Must not be zero.
    /// - `swap_selector` (`felt252`) - The selector of the swap function to call.
    /// - `swap_calldata` (`Span<felt252>`) - The calldata to pass to the swap function.
    /// - `owner_addr` (`ContractAddress`) - The address of the owner who will receive the deposit.
    /// Must not be zero.
    /// - `token` (`ContractAddress`) - The token address to deposit. Must not be zero.
    /// - `amount` (`u128`) - The amount to deposit. Must not be zero.
    /// - `note_id` (`felt252`) - The note id for the deposit. Must not be zero.
    ///
    /// #### Returns
    /// None
    ///
    /// #### Preconditions
    /// - `swap_contract` must not be zero.
    /// - `swap_selector` must not be zero.
    /// - `swap_calldata` must not be empty.
    /// - `owner_addr` must not be zero.
    /// - `token` must not be zero.
    /// - `amount` must not be zero.
    /// - `note_id` must not be zero.
    /// - The note with `note_id` must already exist in the server.
    /// - The caller must be the privacy pool (server) contract.
    ///
    /// #### Events Emitted
    /// TODO.
    ///
    /// #### Reverts
    /// - [`ZERO_PRIVACY_POOL`](swap_executor::errors::ZERO_PRIVACY_POOL): Thrown if the privacy
    /// pool address is zero (should not happen if contract is properly initialized).
    /// - [`INVALID_CALLER`](swap_executor::errors::INVALID_CALLER): Thrown if the caller is not the
    /// privacy pool contract.
    /// - [`ZERO_SWAP_CONTRACT`](swap_executor::errors::ZERO_SWAP_CONTRACT): Thrown if
    /// `swap_contract` is zero.
    /// - [`ZERO_SWAP_SELECTOR`](swap_executor::errors::ZERO_SWAP_SELECTOR): Thrown if
    /// `swap_selector` is zero.
    /// - [`ZERO_SWAP_CALLDATA`](swap_executor::errors::ZERO_SWAP_CALLDATA): Thrown if
    /// `swap_calldata` is empty.
    /// - [`ZERO_OWNER_ADDR`](swap_executor::errors::ZERO_OWNER_ADDR): Thrown if `owner_addr` is
    /// zero.
    /// - [`ZERO_TOKEN`](swap_executor::errors::ZERO_TOKEN): Thrown if `token` is zero.
    /// - [`ZERO_AMOUNT`](swap_executor::errors::ZERO_AMOUNT): Thrown if `amount` is zero.
    /// - [`ZERO_NOTE_ID`](swap_executor::errors::ZERO_NOTE_ID): Thrown if `note_id` is zero.
    /// - [`NOTE_NOT_FOUND`](swap_executor::errors::NOTE_NOT_FOUND): Thrown if the note with
    /// `note_id` does not exist in the server.
    ///
    /// #### Access Control
    /// - Can only be called by the privacy pool contract.
    fn swap_and_deposit(
        ref self: T,
        swap_contract: ContractAddress,
        swap_selector: felt252,
        swap_calldata: Span<felt252>,
        owner_addr: ContractAddress,
        token: ContractAddress,
        amount: u128,
        note_id: felt252,
    );
}

