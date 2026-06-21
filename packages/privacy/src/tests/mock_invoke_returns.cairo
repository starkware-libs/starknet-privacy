//! Mocks used to test invoke return data handling (deserialize error, extra data).

use privacy::objects::OpenNoteDeposit;

#[starknet::interface]
pub trait IMockEcho<T> {
    /// Returns the given deposits as-is (calldata is deserialized as Span<OpenNoteDeposit>).
    fn privacy_invoke(ref self: T, deposits: Span<OpenNoteDeposit>) -> Span<OpenNoteDeposit>;
    /// Same echo behavior as `privacy_invoke`, reached via the `InvokeWithComputation` server
    /// action's selector.
    fn privacy_invoke_with_computation(
        ref self: T, deposits: Span<OpenNoteDeposit>,
    ) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod MockEcho {
    use privacy::objects::OpenNoteDeposit;
    use super::IMockEcho;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockEchoImpl of IMockEcho<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, deposits: Span<OpenNoteDeposit>,
        ) -> Span<OpenNoteDeposit> {
            deposits
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState, deposits: Span<OpenNoteDeposit>,
        ) -> Span<OpenNoteDeposit> {
            deposits
        }
    }
}

/// Mock target for the `ComputeAndInvoke` client / `InvokeWithComputation` server path.
#[starknet::interface]
pub trait IMockCompute<T> {
    fn privacy_compute(self: @T, identity_key: felt252, payload: felt252) -> felt252;
    fn privacy_invoke_with_computation(
        ref self: T, commitment: felt252, deposits: Span<OpenNoteDeposit>,
    ) -> Span<OpenNoteDeposit>;
}

#[starknet::contract]
pub mod MockCompute {
    use privacy::hashes::hash;
    use privacy::objects::OpenNoteDeposit;
    use starknet::storage::{
        Map, StorageMapWriteAccess, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use super::IMockCompute;

    pub const COMPUTE_PANIC: felt252 = 'MOCK_COMPUTE_PANIC';
    pub const INVOKE_PANIC: felt252 = 'MOCK_INVOKE_PANIC';

    #[storage]
    struct Storage {
        panic_on_compute: bool,
        panic_on_invoke: bool,
        commitments: Map<felt252, bool>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, panic_on_compute: bool, panic_on_invoke: bool) {
        self.panic_on_compute.write(panic_on_compute);
        self.panic_on_invoke.write(panic_on_invoke);
    }

    #[abi(embed_v0)]
    pub impl MockComputeImpl of IMockCompute<ContractState> {
        fn privacy_compute(
            self: @ContractState, identity_key: felt252, payload: felt252,
        ) -> felt252 {
            assert(!self.panic_on_compute.read(), COMPUTE_PANIC);
            hash([identity_key, payload].span())
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState, commitment: felt252, deposits: Span<OpenNoteDeposit>,
        ) -> Span<OpenNoteDeposit> {
            assert(!self.panic_on_invoke.read(), INVOKE_PANIC);
            self.commitments.write(commitment, true);
            deposits
        }
    }
}

/// Mock whose `privacy_compute` takes no `compute_data` (only the `identity_key`) and returns a
/// two-felt `compute_result`. Used to exercise `compute_and_invoke`'s assembly with empty
/// `compute_data` and a multi-felt `compute_result`.
#[starknet::interface]
pub trait IMockComputeMultiFelt<T> {
    fn privacy_compute(self: @T, identity_key: felt252) -> (felt252, felt252);
}

#[starknet::contract]
pub mod MockComputeMultiFelt {
    use super::IMockComputeMultiFelt;

    pub const COMPUTED_MARKER: felt252 = 'COMPUTED_MARKER';

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockComputeMultiFeltImpl of IMockComputeMultiFelt<ContractState> {
        fn privacy_compute(self: @ContractState, identity_key: felt252) -> (felt252, felt252) {
            (identity_key, COMPUTED_MARKER)
        }
    }
}

/// Mock whose `privacy_compute` returns no data (unit), producing an empty `compute_result`.
/// Used to exercise `compute_and_invoke`'s rejection of an empty compute result.
#[starknet::interface]
pub trait IMockComputeEmpty<T> {
    fn privacy_compute(self: @T, identity_key: felt252);
}

#[starknet::contract]
pub mod MockComputeEmpty {
    use super::IMockComputeEmpty;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockComputeEmptyImpl of IMockComputeEmpty<ContractState> {
        fn privacy_compute(self: @ContractState, identity_key: felt252) {}
    }
}

/// Returns garbage (a bare felt that cannot deserialize as `Span<OpenNoteDeposit>`) from both the
/// `Invoke` and `InvokeWithComputation` entry points.
#[starknet::interface]
pub trait IMockReturnGarbage<T> {
    fn privacy_invoke(ref self: T) -> felt252;
    fn privacy_invoke_with_computation(ref self: T) -> felt252;
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

        fn privacy_invoke_with_computation(ref self: ContractState) -> felt252 {
            1
        }
    }
}

/// Returns valid deposits followed by trailing garbage (extra felt) from both the `Invoke` and
/// `InvokeWithComputation` entry points.
#[starknet::interface]
pub trait IMockReturnTrailingGarbage<T> {
    fn privacy_invoke(ref self: T) -> (Span<OpenNoteDeposit>, felt252);
    fn privacy_invoke_with_computation(ref self: T) -> (Span<OpenNoteDeposit>, felt252);
}

#[starknet::contract]
pub mod MockReturnTrailingGarbage {
    use privacy::objects::OpenNoteDeposit;
    use super::IMockReturnTrailingGarbage;

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockReturnTrailingGarbageImpl of IMockReturnTrailingGarbage<ContractState> {
        fn privacy_invoke(ref self: ContractState) -> (Span<OpenNoteDeposit>, felt252) {
            ([].span(), 1)
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState,
        ) -> (Span<OpenNoteDeposit>, felt252) {
            ([].span(), 1)
        }
    }
}
