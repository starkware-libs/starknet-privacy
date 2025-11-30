#[starknet::contract]
pub mod backend {
    //use statements
    use backend::interface::IBackend;

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
    pub impl BackendImpl of IBackend<ContractState> { //impl logic
    }
}
