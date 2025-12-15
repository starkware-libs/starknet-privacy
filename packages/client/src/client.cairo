#[starknet::contract]
pub mod Client {
    use client::errors as Errors;
    use client::interface::IClient;
    use client::objects::{NewNote, NotePath};
    use client::utils::{
        derive_public_key, encrypt_channel_info, encrypt_note_amount, get_channel_id,
        get_channel_key, get_note_id, is_canonical_key,
    };
    use core::num::traits::Zero;
    use server::interface::{IServerDispatcher, IServerDispatcherTrait};
    use server::objects::{EncChannelInfo, EncNote};
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        /// Address of the server contract.
        // TODO: Change type to Dispatcher.
        server: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState, server: ContractAddress) {
        assert(server.is_non_zero(), Errors::ZERO_SERVER);
        self.server.write(server);
    }

    #[abi(embed_v0)]
    pub impl ClientImpl of IClient<ContractState> {
        fn open_channel(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            recipient_addr: ContractAddress,
            token: ContractAddress,
            random: felt252,
        ) -> (ContractAddress, EncChannelInfo, felt252) {
            // TODO: Remove assert not zero for sender_addr, recipient_addr?
            // (will fail in the registration check).
            // TODO: Consider generate random instead of passing it as an argument.
            assert(sender_addr.is_non_zero(), Errors::ZERO_SENDER_ADDR);
            assert(sender_private_key.is_non_zero(), Errors::ZERO_SENDER_PRIVATE_KEY);
            assert(recipient_addr.is_non_zero(), Errors::ZERO_RECIPIENT_ADDR);
            assert(token.is_non_zero(), Errors::ZERO_TOKEN);
            assert(random.is_non_zero(), Errors::ZERO_RANDOM);

            // TODO: Verify sender signature on TX.

            // Assert sender private key is canonical.
            assert(is_canonical_key(key: sender_private_key), Errors::PRIVATE_KEY_NOT_CANONICAL);

            // Assert sender is registered with the given private key.
            let server = IServerDispatcher { contract_address: self.server.read() };
            let sender_public_key = server.get_public_key(user: sender_addr);
            assert(
                sender_public_key == derive_public_key(sender_private_key),
                Errors::SENDER_NOT_AUTHENTICATED,
            );

            // Assert recipient is registered.
            let recipient_public_key = server.get_public_key(user: recipient_addr);
            assert(recipient_public_key.is_non_zero(), Errors::RECIPIENT_NOT_REGISTERED);

            // Compute the output values.
            let channel_key = get_channel_key(
                :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key, :token,
            );
            let enc_channel_info = encrypt_channel_info(
                ephemeral_scalar: random, :recipient_public_key, :channel_key, :token, :sender_addr,
            );
            let channel_id = get_channel_id(:channel_key);

            (recipient_addr, enc_channel_info, channel_id)
        }

        fn transfer(
            self: @ContractState,
            owner: ContractAddress,
            owner_private_key: felt252,
            notes_to_use: Span<NotePath>,
            notes_to_create: Span<NewNote>,
        ) -> (Span<felt252>, Span<EncNote>) {
            assert(!notes_to_use.is_empty(), Errors::NO_NOTES_TO_USE);
            assert(!notes_to_create.is_empty(), Errors::NO_NOTES_TO_CREATE);

            // TODO: Verify owner signature on TX.

            let (nullifiers, consumed_sum) = self
                .use_notes(:owner, :owner_private_key, :notes_to_use);
            let (new_notes, created_sum) = self
                .create_notes(owner_addr: owner, :owner_private_key, :notes_to_create);

            // TODO: Consider multi-token support (sum per token).
            // TODO: Implement test to catch this error.
            // TODO: Verify the tokens match in all notes.
            assert(consumed_sum == created_sum, Errors::NOTE_SUM_MISMATCH);

            (nullifiers, new_notes)
        }
    }

    #[generate_trait]
    pub(crate) impl ClientInternalImpl of ClientInternalTrait {
        fn use_notes(
            self: @ContractState,
            owner: ContractAddress,
            owner_private_key: felt252,
            notes_to_use: Span<NotePath>,
        ) -> (Span<felt252>, u256) {
            // TODO: Verify notes exist in server storage.
            // TODO: Sum note amounts.
            // TODO: Verify tokens match.
            // TODO: Return nullifiers span and amount sum.

            ([].span(), Zero::zero())
        }

        fn create_notes(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_create: Span<NewNote>,
        ) -> (Span<EncNote>, u256) {
            let mut enc_notes: Array<EncNote> = array![];
            let mut sum: u256 = Zero::zero();
            let server = IServerDispatcher { contract_address: self.server.read() };
            for note in notes_to_create {
                let (enc_note, amount) = self
                    .create_note(:owner_addr, :owner_private_key, note: *note, :server);
                enc_notes.append(enc_note);
                sum += amount.into();
            }
            (enc_notes.span(), sum)
        }

        /// Returns the encrypted note and the amount of the given new note if it is valid.
        fn create_note(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            note: NewNote,
            server: IServerDispatcher,
        ) -> (EncNote, u128) {
            // TODO: Verify tokens match.
            // TODO: Consider adding context to the errors (which note is causing the error).
            assert(note.recipient_addr.is_non_zero(), Errors::ZERO_RECIPIENT_ADDR);
            assert(note.token.is_non_zero(), Errors::ZERO_TOKEN);
            assert(note.amount.is_non_zero(), Errors::ZERO_AMOUNT);

            // Read recipient public key from server.
            // TODO: Consider using public key from input instead of reading from server.
            let recipient_public_key = server.get_public_key(user: note.recipient_addr);
            assert(recipient_public_key.is_non_zero(), Errors::RECIPIENT_NOT_REGISTERED);

            // Compute channel key.
            let channel_key = get_channel_key(
                sender_addr: owner_addr,
                sender_private_key: owner_private_key,
                recipient_addr: note.recipient_addr,
                :recipient_public_key,
                token: note.token,
            );

            // Assert channel exists.
            let channel_id = get_channel_id(:channel_key);
            assert(server.channel_exists(channel_id), Errors::CHANNEL_NOT_FOUND);

            // Assert index is sequential, i.e. the previous note exists.
            assert(
                note.index.is_zero()
                    || server
                        .get_note(
                            note_id: get_note_id(
                                :channel_key,
                                index: note.index - 1,
                                public_key: recipient_public_key,
                            ),
                        )
                        .is_non_zero(),
                Errors::NOTE_INDEX_NOT_SEQUENTIAL,
            );

            // Compute note values.
            let note_id = get_note_id(
                :channel_key, index: note.index, public_key: recipient_public_key,
            );
            let enc_amount = encrypt_note_amount(:channel_key, amount: note.amount);

            (EncNote { id: note_id, enc_amount }, note.amount)
        }
    }
}
