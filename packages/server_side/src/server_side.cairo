#[starknet::contract]
pub mod ServerSide {
    //use statements
    use server_side::errors::Error;
    use server_side::events::Events;
    use server_side::interface::IServerSide;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address};

    #[storage]
    struct Storage {
        /// Map of user addresses to their viewing keys
        viewing_key: Map<ContractAddress, felt252>,
        /// Map of user addresses to their compliance global viewing keys
        compliance_viewing_key: Map<ContractAddress, felt252>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        Register: Events::Register,
    }

    #[constructor]
    fn constructor(ref self: ContractState) { //constructor logic
    }

    #[abi(embed_v0)]
    pub impl ServerSideImpl of IServerSide<ContractState> {
        fn register(
            ref self: ContractState, viewing_key: felt252, compliance_viewing_key: felt252,
        ) {
            let user = get_caller_address();

            // Assert that keys are empty before writing.
            assert!(self.viewing_key.read(user) == 0, "{}", Error::VIEWING_KEY_ALREADY_EXISTS);
            assert!(
                self.compliance_viewing_key.read(user) == 0,
                "{}",
                Error::COMPLIANCE_VIEWING_KEY_ALREADY_EXISTS,
            );

            // Write keys.
            self.viewing_key.write(user, viewing_key);
            self.compliance_viewing_key.write(user, compliance_viewing_key);

            self.emit(Events::Register { user, viewing_key, compliance_viewing_key });
        }
    }
}
