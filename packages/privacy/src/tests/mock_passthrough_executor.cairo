//! Mock executor that returns the given `Span<DepositToOpenNoteInput>` as-is.
//! Used to test the privacy contract's deposit-matching logic without swap setup.

use privacy::actions::DepositToOpenNoteInput;

#[starknet::interface]
pub trait IPassthroughExecutor<T> {
    /// Returns the given deposits as-is (calldata is deserialized as Span<DepositToOpenNoteInput>).
    fn privacy_invoke(
        ref self: T, deposits: Span<DepositToOpenNoteInput>,
    ) -> Span<DepositToOpenNoteInput>;
}

#[starknet::contract]
pub mod MockPassthroughExecutor {
    use privacy::actions::DepositToOpenNoteInput;
    use super::IPassthroughExecutor;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl PassthroughExecutorImpl of IPassthroughExecutor<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, deposits: Span<DepositToOpenNoteInput>,
        ) -> Span<DepositToOpenNoteInput> {
            deposits
        }
    }
}
