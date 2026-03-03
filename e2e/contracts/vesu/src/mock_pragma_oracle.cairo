use vesu::vendor::pragma::{AggregationMode, DataType, PragmaPricesResponse};

#[starknet::interface]
pub trait IMockPragmaOracle<TContractState> {
    fn get_data(
        self: @TContractState, data_type: DataType, aggregation_mode: AggregationMode,
    ) -> PragmaPricesResponse;
    fn get_data_median(self: @TContractState, data_type: DataType) -> PragmaPricesResponse;
    fn set_price(ref self: TContractState, key: felt252, price: u128);
}

#[starknet::contract]
pub mod MockPragmaOracle {
    use starknet::get_block_timestamp;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use vesu::vendor::pragma::{AggregationMode, DataType, PragmaPricesResponse};

    #[storage]
    struct Storage {
        prices: Map<felt252, u128>,
    }

    #[abi(embed_v0)]
    impl MockPragmaOracleImpl of super::IMockPragmaOracle<ContractState> {
        fn get_data(
            self: @ContractState, data_type: DataType, aggregation_mode: AggregationMode,
        ) -> PragmaPricesResponse {
            self.get_data_median(data_type)
        }

        fn get_data_median(self: @ContractState, data_type: DataType) -> PragmaPricesResponse {
            match data_type {
                DataType::SpotEntry(key) => {
                    PragmaPricesResponse {
                        price: self.prices.read(key),
                        decimals: 18,
                        last_updated_timestamp: get_block_timestamp(),
                        num_sources_aggregated: 2,
                        expiration_timestamp: Option::None,
                    }
                },
                DataType::FutureEntry(_) => {
                    PragmaPricesResponse {
                        price: 0,
                        decimals: 0,
                        last_updated_timestamp: 0,
                        num_sources_aggregated: 0,
                        expiration_timestamp: Option::None,
                    }
                },
                DataType::GenericEntry(_) => {
                    PragmaPricesResponse {
                        price: 0,
                        decimals: 0,
                        last_updated_timestamp: 0,
                        num_sources_aggregated: 0,
                        expiration_timestamp: Option::None,
                    }
                },
            }
        }

        fn set_price(ref self: ContractState, key: felt252, price: u128) {
            self.prices.write(key, price);
        }
    }
}
