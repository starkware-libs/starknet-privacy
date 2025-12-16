#[starknet::contract]
pub mod Client {
    use client::errors;
    use client::interface::IClient;
    use client::objects::{NewNote, NotePath};
    use client::utils::{
        compute_channel_id, compute_channel_key, compute_note_id, derive_public_key,
        encrypt_channel_info, encrypt_note_amount, is_canonical_key,
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
        assert(server.is_non_zero(), errors::ZERO_SERVER);
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
            assert(sender_addr.is_non_zero(), errors::ZERO_SENDER_ADDR);
            assert(sender_private_key.is_non_zero(), errors::ZERO_SENDER_PRIVATE_KEY);
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(random.is_non_zero(), errors::ZERO_RANDOM);

            // TODO: Verify sender signature on TX.

            // Assert sender private key is canonical.
            assert(is_canonical_key(key: sender_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);

            // Assert sender is registered with the given private key.
            let server = IServerDispatcher { contract_address: self.server.read() };
            let sender_public_key = server.get_public_key(user_addr: sender_addr);
            assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
            assert(
                sender_public_key == derive_public_key(private_key: sender_private_key),
                errors::SENDER_NOT_AUTHENTICATED,
            );

            // TODO: Consider passing the recipient's public key as input and moving this check to
            // the server.
            // Assert recipient is registered.
            let recipient_public_key = server.get_public_key(user_addr: recipient_addr);
            assert(recipient_public_key.is_non_zero(), errors::RECIPIENT_NOT_REGISTERED);

            // Compute the output values.
            let channel_key = compute_channel_key(
                :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key, :token,
            );
            let enc_channel_info = encrypt_channel_info(
                ephemeral_secret: random, :recipient_public_key, :channel_key, :token, :sender_addr,
            );
            let channel_id = compute_channel_id(:channel_key);

            (recipient_addr, enc_channel_info, channel_id)
        }

        fn transfer(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_use: Span<NotePath>,
            notes_to_create: Span<NewNote>,
        ) -> (Span<felt252>, Span<EncNote>) {
            assert(owner_addr.is_non_zero(), errors::ZERO_OWNER_ADDR);
            assert(owner_private_key.is_non_zero(), errors::ZERO_OWNER_PRIVATE_KEY);
            assert(!notes_to_use.is_empty(), errors::NO_NOTES_TO_USE);
            assert(!notes_to_create.is_empty(), errors::NO_NOTES_TO_CREATE);

            // TODO: Verify owner signature on TX.

            let (nullifiers, _consumed_sum) = self
                .use_notes(:owner_addr, :owner_private_key, :notes_to_use);
            let (new_notes, _created_sum) = self
                .create_notes(:owner_addr, :owner_private_key, :notes_to_create);

            // TODO: Consider multi-token support (sum per token).
            // TODO: Implement test to catch NOTE_SUM_MISMATCH error.
            // TODO: Verify the tokens match in all notes.
            // TODO: Assert consumed_sum == created_sum.
            // assert(consumed_sum == created_sum, Errors::NOTE_SUM_MISMATCH);

            (nullifiers, new_notes)
        }

        fn deposit(
            self: @ContractState, owner_private_key: felt252, note: NewNote,
        ) -> (ContractAddress, ContractAddress, u128, EncNote) {
            // Assert input is valid.
            assert(owner_private_key.is_non_zero(), errors::ZERO_OWNER_PRIVATE_KEY);

            // TODO: Verify owner signature on TX.

            let owner_addr = note.recipient_addr;
            let server = IServerDispatcher { contract_address: self.server.read() };
            let enc_note = self.create_note(:owner_addr, :owner_private_key, :note, :server);

            (owner_addr, note.token, note.amount, enc_note)
        }
    }

    #[generate_trait]
    pub(crate) impl ClientInternalImpl of ClientInternalTrait {
        fn use_notes(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_use: Span<NotePath>,
        ) -> (Span<felt252>, u256) {
            // TODO: Verify notes exist in server storage.
            // TODO: Sum note amounts.
            // TODO: Verify tokens match.
            // TODO: Return nullifiers span and amount sum.

            ([].span(), Zero::zero())
        }

        // TODO: Consider merging this with `create_note` function.
        fn create_notes(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_create: Span<NewNote>,
        ) -> (Span<EncNote>, u256) {
            // TODO: Consider checking `owner_private_key` here (instead of in calling functions).
            let mut enc_notes: Array<EncNote> = array![];
            let mut sum: u256 = Zero::zero();
            let server = IServerDispatcher { contract_address: self.server.read() };
            for note in notes_to_create {
                let enc_note = self
                    .create_note(:owner_addr, :owner_private_key, note: *note, :server);
                enc_notes.append(enc_note);
                sum += (*note.amount).into();
                // TODO: Verify tokens match.
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
        ) -> EncNote {
            // TODO: Verify tokens match.
            // TODO: Consider adding context to the errors (which note is causing the error).
            assert(note.recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(note.token.is_non_zero(), errors::ZERO_TOKEN);
            assert(note.amount.is_non_zero(), errors::ZERO_AMOUNT);

            // TODO: Consider impl helper function for common code.

            // Read recipient public key from server.
            // TODO: Consider using public key from input instead of reading from server.
            let recipient_public_key = server.get_public_key(user_addr: note.recipient_addr);
            assert(recipient_public_key.is_non_zero(), errors::RECIPIENT_NOT_REGISTERED);

            // Compute channel key.
            let channel_key = compute_channel_key(
                sender_addr: owner_addr,
                sender_private_key: owner_private_key,
                recipient_addr: note.recipient_addr,
                :recipient_public_key,
                token: note.token,
            );

            // Assert channel exists.
            let channel_id = compute_channel_id(:channel_key);
            assert(server.channel_exists(channel_id), errors::CHANNEL_NOT_FOUND);

            // Assert index is sequential, i.e. the previous note exists.
            assert(
                note.index.is_zero()
                    || server
                        .get_note(
                            note_id: compute_note_id(
                                :channel_key,
                                index: note.index - 1,
                                public_key: recipient_public_key,
                            ),
                        )
                        .is_non_zero(),
                errors::NOTE_INDEX_NOT_SEQUENTIAL,
            );

            // Compute note values.
            let note_id = compute_note_id(
                :channel_key, index: note.index, public_key: recipient_public_key,
            );
            let enc_amount = encrypt_note_amount(
                :channel_key, index: note.index, amount: note.amount,
            );

            EncNote { id: note_id, enc_amount }
        }
    }
}
