//! Mocks used to test invoke return data handling (deserialize error, extra data).

use privacy::actions::DepositToOpenNoteInput;

#[starknet::interface]
pub trait IMockEcho<T> {
    /// Returns the given deposits as-is (calldata is deserialized as Span<DepositToOpenNoteInput>).
    fn privacy_invoke(
        ref self: T, deposits: Span<DepositToOpenNoteInput>,
    ) -> Span<DepositToOpenNoteInput>;
}

#[starknet::contract]
pub mod MockEcho {
    use privacy::actions::DepositToOpenNoteInput;
    use super::IMockEcho;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockEchoImpl of IMockEcho<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, deposits: Span<DepositToOpenNoteInput>,
        ) -> Span<DepositToOpenNoteInput> {
            deposits
        }
    }
}

#[starknet::interface]
pub trait IMockReturnGarbage<T> {
    fn privacy_invoke(ref self: T) -> felt252;
}

#[starknet::contract]
pub mod MockReturnGarbage {
    use super::IMockReturnGarbage;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockReturnGarbageImpl of IMockReturnGarbage<ContractState> {
        fn privacy_invoke(ref self: ContractState) -> felt252 {
            1
        }
    }
}

#[starknet::interface]
pub trait IMockReturnTrailingGarbage<T> {
    fn privacy_invoke(ref self: T) -> (Span<DepositToOpenNoteInput>, felt252);
}

#[starknet::contract]
pub mod MockReturnTrailingGarbage {
    use privacy::actions::DepositToOpenNoteInput;
    use super::IMockReturnTrailingGarbage;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockReturnTrailingGarbageImpl of IMockReturnTrailingGarbage<ContractState> {
        fn privacy_invoke(ref self: ContractState) -> (Span<DepositToOpenNoteInput>, felt252) {
            ([].span(), 1)
        }
    }
}
