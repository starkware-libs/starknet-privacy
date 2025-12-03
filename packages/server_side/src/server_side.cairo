#[starknet::contract]
pub mod ServerSide {
    use core::num::traits::zero::Zero;
    use server_side::errors::{
        ENC_VIEWING_KEY_ALREADY_EXISTS, INVALID_ENC_VIEWING_KEY, INVALID_VIEWING_KEY,
        VIEWING_KEY_ALREADY_EXISTS,
    };
    use server_side::events::Events;
    use server_side::interface::IServerSide;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address};

    #[storage]
    struct Storage {
        /// Map of user addresses to their viewing keys.
        viewing_key: Map<ContractAddress, felt252>,
        /// Map of user addresses to their encrypted private keys, encrypted with the compliance
        /// authority's public key.
        enc_compliance_viewing_key: Map<ContractAddress, felt252>,
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
            ref self: ContractState, viewing_key: felt252, enc_compliance_viewing_key: felt252,
        ) {
            // TODO: Only the caller can register themselves?
            let user = get_caller_address();

            // Assert that inputs are valid.
            assert(viewing_key.is_non_zero(), INVALID_VIEWING_KEY);
            assert(enc_compliance_viewing_key.is_non_zero(), INVALID_ENC_VIEWING_KEY);

            // TODO: DO we need to assert that keys are not already registered by another user?

            // Assert that keys are empty before writing.
            assert(self.viewing_key.read(user).is_zero(), VIEWING_KEY_ALREADY_EXISTS);
            assert(
                self.enc_compliance_viewing_key.read(user).is_zero(),
                ENC_VIEWING_KEY_ALREADY_EXISTS,
            );

            // Write keys.
            self.viewing_key.write(user, viewing_key);
            self.enc_compliance_viewing_key.write(user, enc_compliance_viewing_key);

            // TODO: Verify the proof on the encrypted compliance viewing key from the client side.

            self.emit(Events::Register { user, viewing_key, enc_compliance_viewing_key });
        }
    }
}
