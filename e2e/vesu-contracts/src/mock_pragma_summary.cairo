use vesu::vendor::pragma::{AggregationMode, DataType};

#[starknet::interface]
pub trait IMockPragmaSummary<TContractState> {
    fn calculate_twap(
        self: @TContractState,
        data_type: DataType,
        aggregation_mode: AggregationMode,
        time: u64,
        start_time: u64,
    ) -> (u128, u32);
    fn set_twap(ref self: TContractState, key: felt252, twap: u128, decimals: u32);
}

#[starknet::contract]
pub mod MockPragmaSummary {
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use vesu::vendor::pragma::{AggregationMode, DataType};

    #[storage]
    struct Storage {
        twaps: Map<felt252, u128>,
        decimals: u32,
    }

    #[abi(embed_v0)]
    impl MockPragmaSummaryImpl of super::IMockPragmaSummary<ContractState> {
        fn calculate_twap(
            self: @ContractState,
            data_type: DataType,
            aggregation_mode: AggregationMode,
            time: u64,
            start_time: u64,
        ) -> (u128, u32) {
            match data_type {
                DataType::SpotEntry(key) => (self.twaps.read(key), self.decimals.read()),
                DataType::FutureEntry(_) => (0, 0),
                DataType::GenericEntry(_) => (0, 0),
            }
        }

        fn set_twap(ref self: ContractState, key: felt252, twap: u128, decimals: u32) {
            self.twaps.write(key, twap);
            self.decimals.write(decimals);
        }
    }
}
