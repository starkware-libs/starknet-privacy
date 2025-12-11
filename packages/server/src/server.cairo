#[starknet::contract]
pub mod Server {
    use core::num::traits::Zero;
    use server::errors;
    use server::interface::IServer;
    use server::objects::{EncChannelInfo, EncChannelInfoTrait, EncNote};
    use starknet::storage::{
        Map, MutableVecTrait, StorageMapReadAccess, StorageMapWriteAccess, StoragePathEntry,
        StoragePointerReadAccess, Vec, VecTrait,
    };
    use starknet::{ContractAddress, get_caller_address};

    #[storage]
    struct Storage {
        /// Map of recipient addresses to a list of their encrypted channels.
        recipient_channels: Map<ContractAddress, Vec<EncChannelInfo>>,
        /// Map of channel id to whether it exists.
        // TODO: Rename storage var / abi function to not have the same name?
        channel_exists: Map<felt252, bool>,
        /// Map of note ids to their encrypted values.
        notes: Map<felt252, felt252>,
        /// Map of nullifier to whether it exists.
        nullifiers: Map<felt252, bool>,
        /// Map of user addresses to their public viewing keys.
        public_key: Map<ContractAddress, felt252>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState) { //constructor logic
    }

    #[abi(embed_v0)]
    pub impl ServerImpl of IServer<ContractState> {
        fn open_channel(
            ref self: ContractState,
            recipient_addr: ContractAddress,
            enc_channel_info: EncChannelInfo,
            channel_id: felt252,
        ) {
            // Assert inputs are not zero.
            // TODO: Remove assert not zero for hashes?
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(enc_channel_info.is_non_zero(), errors::ZERO_ENC_CHANNEL_INFO);
            assert(channel_id.is_non_zero(), errors::ZERO_CHANNEL_ID);

            // TODO: Verify client's proof.

            // TODO: Consider add `recipient_public_key` to the params and assert it is the current
            // public key of `recipient_addr`.

            // Assert channel does not already exist.
            assert(!self.channel_exists.read(channel_id), errors::CHANNEL_ALREADY_EXISTS);

            // Write channel to storage.
            self.channel_exists.write(channel_id, true);
            self.recipient_channels.entry(recipient_addr).push(enc_channel_info);
        }

        fn channel_exists(self: @ContractState, channel_id: felt252) -> bool {
            // TODO: Restrict access?
            self.channel_exists.read(channel_id)
        }

        fn get_num_of_channels(self: @ContractState, recipient_addr: ContractAddress) -> u64 {
            // TODO: Restrict access to `recipient_addr`?
            // TODO: Assert `recipient_addr` is registered?
            self.recipient_channels.entry(recipient_addr).len()
        }

        fn get_channel_info(
            self: @ContractState, recipient_addr: ContractAddress, channel_index: u64,
        ) -> EncChannelInfo {
            // TODO: Restrict access to `recipient_addr` and client contract?
            // TODO: Assert `recipient_addr` is registered?
            // TODO: Consider defining custom error instead of using `at` (with "Index out of
            // bounds" error)?
            self.recipient_channels.entry(recipient_addr).at(channel_index).read()
        }

        fn get_note(self: @ContractState, note_id: felt252) -> felt252 {
            self.notes.read(note_id)
        }

        fn nullifier_exists(self: @ContractState, nullifier: felt252) -> bool {
            self.nullifiers.read(nullifier)
        }

        fn register(ref self: ContractState, public_key: felt252) {
            // TODO: Add compliance.
            // TODO: Consider remove get_caller_address() and instead pass the user address.
            let user = get_caller_address();

            // Assert that inputs are valid.
            assert(public_key.is_non_zero(), errors::ZERO_PUBLIC_KEY);

            // Assert that keys are empty before writing.
            assert(self.public_key.read(user).is_zero(), errors::USER_ALREADY_REGISTERED);

            // TODO: Verify the proof on the encrypted compliance viewing key from the client side.

            // Write key to storage.
            self.public_key.write(user, public_key);
        }

        fn get_public_key(self: @ContractState, user: ContractAddress) -> felt252 {
            self.public_key.read(user)
        }
    }

    #[generate_trait]
    pub(crate) impl ServerInternalImpl of ServerInternalTrait {
        fn create_note(ref self: ContractState, note: EncNote) {
            // Assert inputs are not zero.
            // TODO: Remove assert not zero for hashes?
            assert(note.id.is_non_zero(), errors::ZERO_NOTE_ID);
            assert(note.enc_amount.is_non_zero(), errors::ZERO_ENC_NOTE_VALUE);

            // Assert note does not already exist.
            assert(self.notes.read(note.id).is_zero(), errors::NOTE_ALREADY_EXISTS);

            // Write note to storage.
            self.notes.write(note.id, note.enc_amount);
        }

        fn use_note(ref self: ContractState, nullifier: felt252) {
            // Assert inputs are not zero.
            // TODO: Remove assert not zero for hashes?
            assert(nullifier.is_non_zero(), errors::ZERO_NULLIFIER);

            // Assert nullifier does not already exist.
            assert(!self.nullifiers.read(nullifier), errors::NULLIFIER_ALREADY_EXISTS);

            // Write nullifier to storage.
            self.nullifiers.write(nullifier, true);
        }
    }
}
