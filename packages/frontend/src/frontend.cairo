#[starknet::contract]
pub mod frontend {
    //use statements
    use frontend::interface::IFrontend;

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
    pub impl FrontendImpl of IFrontend<ContractState> { //impl logic
    }
}
