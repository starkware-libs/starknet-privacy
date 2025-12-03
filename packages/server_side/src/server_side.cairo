#[starknet::contract]
pub mod ServerSide {
    use core::num::traits::zero::Zero;
    use server_side::errors::{INVALID_PUBLIC_KEY, PUBLIC_KEY_ALREADY_EXISTS};
    use server_side::events::Events;
    use server_side::interface::IServerSide;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address};

    #[storage]
    struct Storage {
        /// Map of user addresses to their public viewing keys.
        public_key: Map<ContractAddress, felt252>,
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
        fn register(ref self: ContractState, public_key: felt252) {
            // TODO: Add compliance.
            let user = get_caller_address();

            // Assert that inputs are valid.
            assert(public_key.is_non_zero(), INVALID_PUBLIC_KEY);

            // Assert that keys are empty before writing.
            assert(self.public_key.read(user).is_zero(), PUBLIC_KEY_ALREADY_EXISTS);

            // Write keys.
            self.public_key.write(user, public_key);

            // TODO: Verify the proof on the encrypted compliance viewing key from the client side.

            self.emit(Events::Register { user, public_key });
        }
    }
}
