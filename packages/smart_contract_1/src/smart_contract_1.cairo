#[starknet::contract]
pub mod smart_contract_1 {
    //use statements
    use smart_contract_1::interface::ISmartContract1;

    #[storage]
    struct Storage { //storage variables
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState) { //constructor logic
    }

    #[abi(embed_v0)]
    pub impl SmartContract1Impl of ISmartContract1<ContractState> { //impl logic
    }
}
