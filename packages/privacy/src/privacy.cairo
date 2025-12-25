#[starknet::contract]
pub mod Privacy {
    use core::num::traits::Zero;
    use openzeppelin::token::erc20::interface::IERC20Dispatcher;
    use privacy::errors;
    use privacy::interface::{IClient, IServer, IViews};
    use privacy::objects::{
        EncChannelInfo, EncChannelInfoTrait, EncNote, NewNote, NotePath, ServerAction,
    };
    use privacy::utils::{
        StoragePathIntoFelt, compute_channel_id, compute_channel_key, compute_note_id,
        compute_nullifier, decrypt_channel_info, decrypt_note_amount, derive_public_key,
        encrypt_channel_info, encrypt_note_amount, is_canonical_key,
    };
    use starknet::storage::{
        Map, Mutable, MutableVecTrait, StorageBase, StorageMapReadAccess, StorageMapWriteAccess,
        StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess, Vec, VecTrait,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use starkware_utils::erc20::erc20_utils::CheckedIERC20DispatcherTrait;

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
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl ClientImpl of IClient<ContractState> {
        fn prepare_open_channel(
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
            let sender_public_key = self.get_public_key(user_addr: sender_addr);
            assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
            assert(
                sender_public_key == derive_public_key(private_key: sender_private_key),
                errors::SENDER_NOT_AUTHENTICATED,
            );

            // TODO: Consider passing the recipient's public key as input and moving this check to
            // the server.
            // Assert recipient is registered.
            let recipient_public_key = self.get_public_key(user_addr: recipient_addr);
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

        fn prepare_transfer(
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

            let (nullifiers, consumed_sum) = self
                .use_notes(:owner_addr, :owner_private_key, :notes_to_use);
            let (new_notes, created_sum) = self
                .create_notes(:owner_addr, :owner_private_key, :notes_to_create);

            // TODO: Consider multi-token support (sum per token).
            // TODO: Verify the tokens match in all notes.
            assert(consumed_sum == created_sum, errors::NOTE_SUM_MISMATCH);

            (nullifiers, new_notes)
        }

        fn prepare_deposit(
            self: @ContractState, owner_private_key: felt252, new_note: NewNote,
        ) -> (ContractAddress, ContractAddress, u128, EncNote) {
            // Assert input is valid.
            assert(owner_private_key.is_non_zero(), errors::ZERO_OWNER_PRIVATE_KEY);

            // TODO: Verify owner signature on TX.

            let owner_addr = new_note.recipient_addr;
            let enc_note = self.create_note(:owner_addr, :owner_private_key, note: new_note);

            (owner_addr, new_note.token, new_note.amount, enc_note)
        }

        fn prepare_withdraw(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            withdrawal_target: ContractAddress,
            note_to_withdraw: NotePath,
        ) -> (ContractAddress, ContractAddress, u128, felt252) {
            // Assert valid input.
            assert(owner_addr.is_non_zero(), errors::ZERO_OWNER_ADDR);
            assert(owner_private_key.is_non_zero(), errors::ZERO_OWNER_PRIVATE_KEY);
            assert(withdrawal_target.is_non_zero(), errors::ZERO_WITHDRAWAL_TARGET);

            let (nullifier, token, amount) = self
                .use_note(:owner_addr, :owner_private_key, note: note_to_withdraw);

            (withdrawal_target, token, amount, nullifier)
        }
    }

    #[generate_trait]
    pub(crate) impl ClientInternalImpl of ClientInternalTrait {
        // TODO: Consider merging this with `use_note` function.
        fn use_notes(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_use: Span<NotePath>,
        ) -> (Span<felt252>, u256) {
            // TODO: Verify tokens match.
            let mut nullifiers: Array<felt252> = array![];
            let mut sum: u256 = Zero::zero();
            for note in notes_to_use {
                let (nullifier, _token, amount) = self
                    .use_note(:owner_addr, :owner_private_key, note: *note);
                nullifiers.append(nullifier);
                sum += amount.into();
            }
            (nullifiers.span(), sum)
        }

        // Returns (nullifier, token, amount).
        fn use_note(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            note: NotePath,
        ) -> (felt252, ContractAddress, u128) {
            // Read and decrypt channel key and token from storage.
            // TODO: Assert token matches.
            let enc_channel_info = self
                .get_channel_info(recipient_addr: owner_addr, channel_index: note.channel_index);
            let (channel_key, token) = decrypt_channel_info(
                :enc_channel_info, recipient_private_key: owner_private_key,
            );

            // Compute note id.
            let owner_public_key = derive_public_key(private_key: owner_private_key);
            let note_id = compute_note_id(
                :channel_key, index: note.note_index, public_key: owner_public_key,
            );

            // Read note from storage and assert it exists.
            let enc_note_value = self.get_note(:note_id);
            assert(enc_note_value.is_non_zero(), errors::NOTE_NOT_FOUND);

            // Decrypt note amount.
            let note_amount = decrypt_note_amount(
                :enc_note_value, :channel_key, index: note.note_index,
            );
            // TODO: Sanity assert amount is non zero?

            // Compute nullifier.
            let nullifier = compute_nullifier(
                :channel_key, index: note.note_index, :owner_private_key,
            );

            // Return nullifier, token, and amount.
            (nullifier, token, note_amount)
        }

        // TODO: Consider merging this with `create_note` function.
        fn create_notes(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_create: Span<NewNote>,
        ) -> (Span<EncNote>, u256) {
            let mut enc_notes: Array<EncNote> = array![];
            let mut sum: u256 = Zero::zero();
            for note in notes_to_create {
                let enc_note = self.create_note(:owner_addr, :owner_private_key, note: *note);
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
        ) -> EncNote {
            // TODO: Verify tokens match.
            // TODO: Consider adding context to the errors (which note is causing the error).
            assert(note.recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(note.token.is_non_zero(), errors::ZERO_TOKEN);
            assert(note.amount.is_non_zero(), errors::ZERO_AMOUNT);

            // TODO: Consider impl helper function for common code.

            // Read recipient public key from storage.
            // TODO: Consider using public key from input instead of reading from storage.
            let recipient_public_key = self.get_public_key(user_addr: note.recipient_addr);
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
            assert(self.channel_exists(:channel_id), errors::CHANNEL_NOT_FOUND);

            // Assert index is sequential, i.e. the previous note exists.
            assert(
                note.index.is_zero()
                    || self
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

    #[abi(embed_v0)]
    pub impl ServerImpl of IServer<ContractState> {
        fn execute_actions(ref self: ContractState, actions: Span<ServerAction>) {
            for action in actions {
                match *action {
                    ServerAction::WriteIfZero((
                        storage_address, value,
                    )) => { self._execute_write_if_zero(:storage_address, :value); },
                    ServerAction::AppendToVec((
                        recipient_addr, enc_channel_info,
                    )) => {
                        self
                            ._execute_append_to_vector(
                                key: recipient_addr, value: enc_channel_info,
                            );
                    },
                };
            };
        }

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

            let actions: Array<ServerAction> = array![
                ServerAction::WriteIfZero(
                    (self.channel_exists.entry(channel_id).into(), true.into()),
                ),
                ServerAction::AppendToVec((recipient_addr, enc_channel_info)),
            ];
            self.execute_actions(actions.span());
        }

        fn register(ref self: ContractState, public_key: felt252) {
            // TODO: Add compliance.
            // TODO: Consider remove get_caller_address() and instead pass the user address.
            let user_addr = get_caller_address();

            // Assert that inputs are valid.
            assert(public_key.is_non_zero(), errors::ZERO_PUBLIC_KEY);

            // TODO: Verify the proof on the encrypted compliance viewing key from the client side.

            let actions: Array<ServerAction> = array![
                ServerAction::WriteIfZero((self.public_key.entry(user_addr).into(), public_key)),
            ];
            self.execute_actions(actions.span());
        }

        fn replace_public_key(ref self: ContractState, public_key: felt252) {
            // TODO: Add compliance.
            // TODO: Consider remove get_caller_address() and instead pass the user address.
            // TODO: Enforce cooldown between key replacements? (track last update time).
            let user_addr = get_caller_address();

            // Assert that input is valid.
            assert(public_key.is_non_zero(), errors::ZERO_PUBLIC_KEY);

            // Assert that user has already registered.
            assert(self.get_public_key(:user_addr).is_non_zero(), errors::USER_NOT_REGISTERED);

            // TODO: Verify the proof from the client side.

            // Replace the key in storage.
            self.public_key.write(user_addr, public_key);
        }

        fn deposit(
            ref self: ContractState,
            user_addr: ContractAddress,
            token: ContractAddress,
            amount: u128,
            note: EncNote,
        ) {
            // Assert inputs are valid.
            assert(user_addr.is_non_zero(), errors::ZERO_USER_ADDR);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);

            self._create_note(:note);

            IERC20Dispatcher { contract_address: token }
                .checked_transfer_from(
                    sender: user_addr, recipient: get_contract_address(), amount: amount.into(),
                );
        }

        fn transfer(ref self: ContractState, nullifiers: Span<felt252>, new_notes: Span<EncNote>) {
            // Assert inputs are valid.
            assert(!nullifiers.is_empty(), errors::EMPTY_NULLIFIERS);
            assert(!new_notes.is_empty(), errors::EMPTY_NEW_NOTES);

            // Mark notes as used.
            for nullifier in nullifiers {
                self._use_note(nullifier: *nullifier);
            }

            // Create new notes.
            for note in new_notes {
                self._create_note(note: *note);
            }
        }

        fn withdraw(
            ref self: ContractState,
            recipient_addr: ContractAddress,
            token: ContractAddress,
            amount: u128,
            nullifier: felt252,
        ) {
            // Assert inputs are valid.
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(nullifier.is_non_zero(), errors::ZERO_NULLIFIER);

            self._use_note(:nullifier);

            IERC20Dispatcher { contract_address: token }
                .checked_transfer(recipient: recipient_addr, amount: amount.into());
        }
    }

    #[generate_trait]
    pub impl ServerInternalImpl of ServerInternalTrait {
        fn _create_note(ref self: ContractState, note: EncNote) {
            // Assert inputs are not zero.
            // TODO: Remove assert not zero for hashes?
            assert(note.id.is_non_zero(), errors::ZERO_NOTE_ID);
            assert(note.enc_amount.is_non_zero(), errors::ZERO_ENC_NOTE_VALUE);

            // Assert note does not already exist.
            assert(self.notes.read(note.id).is_zero(), errors::NOTE_ALREADY_EXISTS);

            // Write note to storage.
            self.notes.write(note.id, note.enc_amount);
        }

        fn _use_note(ref self: ContractState, nullifier: felt252) {
            // Assert inputs are not zero.
            // TODO: Remove assert not zero for hashes?
            assert(nullifier.is_non_zero(), errors::ZERO_NULLIFIER);

            // Assert nullifier does not already exist.
            assert(!self.nullifiers.read(nullifier), errors::NULLIFIER_ALREADY_EXISTS);

            // Write nullifier to storage.
            self.nullifiers.write(nullifier, true);
        }

        fn _execute_write_if_zero(
            ref self: ContractState, storage_address: felt252, value: felt252,
        ) {
            let mut target = StorageBase::<Mutable<felt252>> { __base_address__: storage_address };
            assert(target.read().is_zero(), errors::NON_ZERO_VALUE);
            target.write(value);
        }

        // TODO: Make generic.
        fn _execute_append_to_vector(
            ref self: ContractState, key: ContractAddress, value: EncChannelInfo,
        ) {
            self.recipient_channels.entry(key).push(value);
        }
    }

    #[abi(embed_v0)]
    pub impl ViewsImpl of IViews<ContractState> {
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

        fn get_public_key(self: @ContractState, user_addr: ContractAddress) -> felt252 {
            self.public_key.read(user_addr)
        }
    }
}
