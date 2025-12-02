#[starknet::contract]
pub mod ServerSide {
    use server_side::interface::IServerSide;
    use starknet::storage::{Map, StoragePathEntry, StoragePointerReadAccess};

    #[storage]
    struct Storage {
        notes: Map<felt252, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState) { //constructor logic
    }

    #[abi(embed_v0)]
    pub impl ServerSideImpl of IServerSide<ContractState> {
        fn is_active(self: @ContractState, note: felt252) -> bool {
            // TODO: Handle nullified notes.
            self.notes.entry(note).read()
        }
    }
}
