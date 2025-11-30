#[starknet::contract]
pub mod server_side {
    //use statements
    use server_side::interface::IServerSide;

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
    pub impl ServerSideImpl of IServerSide<ContractState> { //impl logic
    }
}
