#[starknet::contract]
pub mod client_side {
    //use statements
    use client_side::interface::IClientSide;

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
    pub impl ClientSideImpl of IClientSide<ContractState> { //impl logic
    }
}
