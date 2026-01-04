#[starknet::contract]
pub mod Privacy {
    use core::iter::Extend;
    use core::num::traits::Zero;
    use openzeppelin::token::erc20::interface::IERC20Dispatcher;
    use privacy::errors;
    use privacy::errors::internal_errors;
    use privacy::hashes::{
        compute_channel_id, compute_channel_key, compute_note_id, compute_nullifier,
        compute_subchannel_id, compute_subchannel_key,
    };
    use privacy::interface::{IClient, IServer, IViews};
    use privacy::objects::{
        ClientAction, EncChannelInfo, EncChannelInfoTrait, EncPrivateKey, EncSubchannelInfo,
        NewNote, NotePath, ServerAction,
    };
    use privacy::utils::{
        StoragePathIntoFelt, decrypt_note_amount, derive_public_key, encrypt_channel_info,
        encrypt_note_amount, encrypt_private_key, encrypt_subchannel_info, is_canonical_key,
    };
    use starknet::storage::{
        Map, Mutable, MutableVecTrait, StorageBase, StorageMapReadAccess, StoragePathEntry,
        StoragePointerReadAccess, StoragePointerWriteAccess, Vec, VecTrait,
    };
    use starknet::{ContractAddress, get_contract_address};
    use starkware_utils::erc20::erc20_utils::CheckedIERC20DispatcherTrait;

    #[storage]
    struct Storage {
        /// Map of (recipient_addr, recipient_public_key) to a list of their encrypted channels.
        // TODO: Consider refactoring the tuple to a struct.
        recipient_channels: Map<(ContractAddress, felt252), Vec<EncChannelInfo>>,
        /// Map of channel id to whether it exists.
        // TODO: Rename storage var / abi function to not have the same name?
        channel_exists: Map<felt252, bool>,
        /// Map of subchannel keys to their encrypted tokens.
        subchannel_tokens: Map<felt252, EncSubchannelInfo>,
        /// Map of subchannel id to whether it exists.
        subchannel_exists: Map<felt252, bool>,
        /// Map of note ids to their encrypted values.
        notes: Map<felt252, felt252>,
        /// Map of nullifier to whether it exists.
        nullifiers: Map<felt252, bool>,
        /// Map of user addresses to their public viewing keys.
        public_key: Map<ContractAddress, felt252>,
        /// Map of user addresses to their encrypted private key.
        enc_private_key: Map<ContractAddress, EncPrivateKey>,
        // TODO: Do we need setter for this?
        /// Public key of the compliance used for private key encryptions.
        compliance_public_key: felt252,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event { //event variables
    }

    #[constructor]
    fn constructor(ref self: ContractState, compliance_public_key: felt252) {
        self.compliance_public_key.write(compliance_public_key);
    }

    // TODO: Use direct storage access instead of using views.
    #[abi(embed_v0)]
    pub impl ClientImpl of IClient<ContractState> {
        fn transfer(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_use: Span<NotePath>,
            notes_to_create: Span<NewNote>,
        ) -> Span<ServerAction> {
            assert(owner_addr.is_non_zero(), errors::ZERO_OWNER_ADDR);
            assert(owner_private_key.is_non_zero(), errors::ZERO_OWNER_PRIVATE_KEY);
            assert(!notes_to_use.is_empty(), errors::NO_NOTES_TO_USE);
            assert(!notes_to_create.is_empty(), errors::NO_NOTES_TO_CREATE);

            // TODO: Assert owner_private_key is canonical.

            // TODO: Verify owner signature on TX.

            let mut actions: Array<ServerAction> = array![];
            let consumed_sum = self
                .use_notes(ref :actions, :owner_addr, :owner_private_key, :notes_to_use);
            assert(actions.len() == notes_to_use.len(), internal_errors::ACTIONS_LENGTH_MISMATCH);
            let created_sum = self
                .create_notes(ref :actions, :owner_addr, :owner_private_key, :notes_to_create);
            assert(
                actions.len() == notes_to_use.len() + notes_to_create.len(),
                internal_errors::ACTIONS_LENGTH_MISMATCH,
            );

            // TODO: Verify sums per token. (Now tokens are not verified at all.)
            assert(consumed_sum == created_sum.into(), errors::NOTE_SUM_MISMATCH);

            actions.span()
        }

        fn withdraw(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            withdrawal_target: ContractAddress,
            note_to_withdraw: NotePath,
        ) -> Span<ServerAction> {
            // Assert valid input.
            assert(owner_addr.is_non_zero(), errors::ZERO_OWNER_ADDR);
            assert(owner_private_key.is_non_zero(), errors::ZERO_OWNER_PRIVATE_KEY);
            assert(withdrawal_target.is_non_zero(), errors::ZERO_WITHDRAWAL_TARGET);

            // TODO: Assert owner_private_key is canonical.

            // TODO: Verify owner signature on TX.

            let (nullifier, amount) = self
                .use_note(:owner_addr, :owner_private_key, note: note_to_withdraw);

            [
                ServerAction::WriteIfZero((self.nullifiers.entry(nullifier).into(), true.into())),
                ServerAction::TransferTo((withdrawal_target, note_to_withdraw.token, amount)),
            ]
                .span()
        }

        fn compile_client_actions(
            self: @ContractState, user_addr: ContractAddress, client_actions: Span<ClientAction>,
        ) -> Span<ServerAction> {
            assert(user_addr.is_non_zero(), errors::ZERO_USER_ADDR);
            // TODO: Consider asserting that `client_actions` is not empty.
            // TODO: Consider refactoring internal functions to return `Span<ServerAction>`.
            let mut server_actions: Array<ServerAction> = array![];
            for client_action in client_actions {
                match *client_action {
                    ClientAction::Register((
                        user_private_key, random,
                    )) => {
                        server_actions
                            .extend(self.register(:user_addr, :user_private_key, :random));
                    },
                    ClientAction::ReplacePublicKey(user_public_key) => {
                        server_actions
                            .append(self.replace_public_key(:user_addr, :user_public_key));
                    },
                    ClientAction::OpenChannel((
                        user_private_key, recipient_addr, recipient_public_key, random,
                    )) => {
                        server_actions
                            .extend(
                                self
                                    .open_channel(
                                        sender_addr: user_addr,
                                        sender_private_key: user_private_key,
                                        :recipient_addr,
                                        :recipient_public_key,
                                        :random,
                                    ),
                            );
                    },
                    ClientAction::OpenSubchannel((
                        recipient_addr, recipient_public_key, channel_key, index, token, random,
                    )) => {
                        server_actions
                            .extend(
                                self
                                    .open_subchannel(
                                        sender_addr: user_addr,
                                        :recipient_addr,
                                        :recipient_public_key,
                                        :channel_key,
                                        :index,
                                        :token,
                                        :random,
                                    ),
                            );
                    },
                    ClientAction::CreateNote((
                        user_private_key, new_note,
                    )) => {
                        server_actions
                            .append(
                                self
                                    .create_note(
                                        owner_addr: user_addr,
                                        owner_private_key: user_private_key,
                                        note: new_note,
                                    ),
                            );
                    },
                    ClientAction::Deposit((
                        token, amount,
                    )) => { server_actions.append(self.deposit(:user_addr, :token, :amount)); },
                }
            }
            server_actions.span()
        }
    }

    #[generate_trait]
    pub(crate) impl ClientInternalImpl of ClientInternalTrait {
        /// `user_addr` is assumed to be non-zero (checked in `compile_client_actions`).
        fn register(
            self: @ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            random: felt252,
        ) -> Array<ServerAction> {
            assert(user_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
            assert(random.is_non_zero(), errors::ZERO_RANDOM);
            assert(is_canonical_key(key: user_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);
            let user_public_key = derive_public_key(private_key: user_private_key);
            assert(user_public_key.is_non_zero(), internal_errors::ZERO_DERIVED_PUBLIC_KEY);
            let enc_private_key = encrypt_private_key(
                ephemeral_secret: random,
                compliance_public_key: self.compliance_public_key.read(),
                private_key: user_private_key,
            );
            assert(enc_private_key.is_non_zero(), internal_errors::ZERO_ENC_PRIVATE_KEY);

            array![
                ServerAction::WriteIfZero(
                    (self.public_key.entry(user_addr).into(), user_public_key),
                ),
                ServerAction::WriteIfZeroPrivateKey(
                    (self.enc_private_key.entry(user_addr).into(), enc_private_key),
                ),
            ]
        }

        /// `user_addr` is assumed to be non-zero (checked in `compile_client_actions`).
        fn replace_public_key(
            self: @ContractState, user_addr: ContractAddress, user_public_key: felt252,
        ) -> ServerAction {
            // TODO: Add compliance.
            // TODO: Enforce cooldown between key replacements? (track last update time).
            assert(user_public_key.is_non_zero(), errors::ZERO_PUBLIC_KEY);

            ServerAction::WriteIfNonZero((self.public_key.entry(user_addr).into(), user_public_key))
        }

        /// `sender_addr` is assumed to be non-zero (checked in `compile_client_actions`).
        fn open_channel(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            recipient_addr: ContractAddress,
            recipient_public_key: felt252,
            random: felt252,
        ) -> Array<ServerAction> {
            // TODO: Consider generate random instead of passing it as an argument.
            assert(sender_private_key.is_non_zero(), errors::ZERO_SENDER_PRIVATE_KEY);
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
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

            // Compute the output values.
            let channel_key = compute_channel_key(
                :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key,
            );
            let enc_channel_info = encrypt_channel_info(
                ephemeral_secret: random, :recipient_public_key, :channel_key, :sender_addr,
            );
            let channel_id = compute_channel_id(
                :channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
            );

            assert(channel_id.is_non_zero(), internal_errors::ZERO_CHANNEL_ID);
            assert(enc_channel_info.is_non_zero(), internal_errors::ZERO_ENC_CHANNEL_INFO);

            array![
                ServerAction::VerifyValue(
                    (self.public_key.entry(recipient_addr).into(), recipient_public_key),
                ),
                ServerAction::WriteIfZero(
                    (self.channel_exists.entry(channel_id).into(), true.into()),
                ),
                ServerAction::AppendToVec((recipient_addr, recipient_public_key, enc_channel_info)),
            ]
        }

        /// `sender_addr` is assumed to be non-zero (checked in `compile_client_actions`).
        fn open_subchannel(
            self: @ContractState,
            sender_addr: ContractAddress,
            recipient_addr: ContractAddress,
            recipient_public_key: felt252,
            channel_key: felt252,
            index: usize,
            token: ContractAddress,
            random: felt252,
        ) -> Array<ServerAction> {
            // TODO: Consider generate random instead of passing it as an argument.
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
            assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(random.is_non_zero(), errors::ZERO_RANDOM);

            // TODO: Verify sender signature on TX.

            // Assert channel key is valid for the given sender and recipient.
            let channel_id = compute_channel_id(
                :channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
            );
            assert(self.channel_exists.read(channel_id), errors::INVALID_CHANNEL);

            // Assert index is sequential, i.e. the previous subchannel exists.
            assert(
                index.is_zero()
                    || self
                        .subchannel_tokens
                        .read(compute_subchannel_key(:channel_key, index: index - 1))
                        .is_non_zero(),
                errors::INDEX_NOT_SEQUENTIAL,
            );

            // Compute subchannel values.
            let subchannel_id = compute_subchannel_id(
                :channel_key, :recipient_addr, :recipient_public_key, :token,
            );
            let subchannel_key = compute_subchannel_key(:channel_key, :index);
            let enc_subchannel_info = encrypt_subchannel_info(:channel_key, :token, :random);
            assert(subchannel_id.is_non_zero(), internal_errors::ZERO_SUBCHANNEL_ID);
            assert(subchannel_key.is_non_zero(), internal_errors::ZERO_SUBCHANNEL_KEY);
            assert(enc_subchannel_info.is_non_zero(), internal_errors::ZERO_ENC_SUBCHANNEL_TOKEN);

            array![
                ServerAction::WriteIfZero(
                    (self.subchannel_exists.entry(subchannel_id).into(), true.into()),
                ),
                ServerAction::WriteIfZeroSubchannel(
                    (self.subchannel_tokens.entry(subchannel_key).into(), enc_subchannel_info),
                ),
            ]
        }

        /// `user_addr` is assumed to be non-zero (checked in `compile_client_actions`).
        fn deposit(
            self: @ContractState, user_addr: ContractAddress, token: ContractAddress, amount: u128,
        ) -> ServerAction {
            // Assert input is valid.
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);

            ServerAction::TransferFrom((user_addr, token, amount))
        }

        /// Returns the sum of the amounts of the notes to use.
        fn use_notes(
            self: @ContractState,
            ref actions: Array<ServerAction>,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_use: Span<NotePath>,
        ) -> u256 {
            // TODO: Verify sums per token. (Now tokens are not verified at all.)
            let mut sum: u256 = Zero::zero();
            for note in notes_to_use {
                let (nullifier, amount) = self
                    .use_note(:owner_addr, :owner_private_key, note: *note);
                actions
                    .append(
                        ServerAction::WriteIfZero(
                            (self.nullifiers.entry(nullifier).into(), true.into()),
                        ),
                    );
                sum += amount.into();
            }
            sum
        }

        /// Returns (nullifier, amount).
        /// Assumes `owner_private_key` is canonical.
        fn use_note(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            note: NotePath,
        ) -> (felt252, u128) {
            // TODO: Consider adding context to the errors (which note is causing the error).
            assert(note.channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY);
            assert(note.token.is_non_zero(), errors::ZERO_TOKEN);
            // TODO: Assert amount per token.

            // Assert subchannel exists and is connected to owner's address and public key.
            let channel_key = note.channel_key;
            let recipient_public_key = derive_public_key(private_key: owner_private_key);
            let token = note.token;
            let subchannel_id = compute_subchannel_id(
                :channel_key, recipient_addr: owner_addr, :recipient_public_key, :token,
            );
            assert(self.subchannel_exists.read(subchannel_id), errors::INVALID_SUBCHANNEL);

            // Compute note id.
            let index = note.note_index;
            let note_id = compute_note_id(:channel_key, :token, :index);

            // Read note from storage and assert it exists.
            let enc_note_value = self.get_note(:note_id);
            assert(enc_note_value.is_non_zero(), errors::NOTE_NOT_FOUND);

            // Decrypt note amount.
            let note_amount = decrypt_note_amount(:enc_note_value, :channel_key);
            // TODO: Sanity assert amount is non zero?

            // Compute nullifier.
            let nullifier = compute_nullifier(:channel_key, :token, :index, :owner_private_key);

            assert(nullifier.is_non_zero(), internal_errors::ZERO_NULLIFIER);

            // Return nullifier, and amount.
            (nullifier, note_amount)
        }

        /// Returns the sum of the amounts of the notes to create.
        // TODO: Remove with `transfer` function.
        fn create_notes(
            self: @ContractState,
            ref actions: Array<ServerAction>,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            notes_to_create: Span<NewNote>,
        ) -> u128 {
            let mut sum: u128 = Zero::zero();
            for note in notes_to_create {
                let create_note_action = self
                    .create_note(:owner_addr, :owner_private_key, note: *note);
                actions.append(create_note_action);
                sum += *note.amount;
                // TODO: Assert amount per token.
            }
            sum
        }

        /// Returns the server action to create a note.
        /// Assumes `owner_private_key` is canonical.
        fn create_note(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            note: NewNote,
        ) -> ServerAction {
            // TODO: Consider adding context to the errors (which note is causing the error).
            assert(note.recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(note.recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
            assert(note.token.is_non_zero(), errors::ZERO_TOKEN);
            assert(note.amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(note.random.is_non_zero(), errors::ZERO_RANDOM);
            // TODO: Assert random bounds.

            // TODO: Consider impl helper function for common code.

            // Compute channel key.
            let recipient_addr = note.recipient_addr;
            let recipient_public_key = note.recipient_public_key;
            let channel_key = compute_channel_key(
                sender_addr: owner_addr,
                sender_private_key: owner_private_key,
                :recipient_addr,
                :recipient_public_key,
            );

            // Assert subchannel exists.
            let token = note.token;
            let subchannel_id = compute_subchannel_id(
                :channel_key, :recipient_addr, :recipient_public_key, :token,
            );
            assert(self.subchannel_exists.read(subchannel_id), errors::INVALID_SUBCHANNEL);

            // Assert index is sequential, i.e. the previous note exists.
            let index = note.index;
            assert(
                index.is_zero()
                    || self
                        .get_note(note_id: compute_note_id(:channel_key, :token, index: index - 1))
                        .is_non_zero(),
                errors::INDEX_NOT_SEQUENTIAL,
            );

            // Compute note values.
            let note_id = compute_note_id(:channel_key, :token, :index);
            let enc_amount = encrypt_note_amount(
                :channel_key, random: note.random, amount: note.amount,
            );

            assert(note_id.is_non_zero(), internal_errors::ZERO_NOTE_ID);
            assert(enc_amount.is_non_zero(), internal_errors::ZERO_ENC_NOTE_VALUE);

            // TODO: Keep track of token balances.

            ServerAction::WriteIfZero((self.notes.entry(note_id).into(), enc_amount))
        }
    }

    #[abi(embed_v0)]
    pub impl ServerImpl of IServer<ContractState> {
        fn execute_actions(ref self: ContractState, actions: Span<ServerAction>) {
            for action in actions {
                match *action {
                    ServerAction::WriteIfZero((
                        storage_address, new_value,
                    )) => {
                        self._execute_write(:storage_address, :new_value, require_zero: true);
                    },
                    ServerAction::WriteIfZeroSubchannel((
                        storage_address, new_value,
                    )) => { self._execute_write_subchannel(:storage_address, :new_value); },
                    ServerAction::WriteIfZeroPrivateKey((
                        storage_address, new_value,
                    )) => {
                        self
                            ._execute_write_private_key(
                                :storage_address, :new_value, require_zero: true,
                            );
                    },
                    ServerAction::AppendToVec((
                        recipient_addr, recipient_public_key, enc_channel_info,
                    )) => {
                        self
                            ._execute_append_to_vector(
                                key: (recipient_addr, recipient_public_key),
                                value: enc_channel_info,
                            );
                    },
                    ServerAction::WriteIfNonZero((
                        storage_address, new_value,
                    )) => {
                        self._execute_write(:storage_address, :new_value, require_zero: false);
                    },
                    ServerAction::TransferFrom((
                        sender, token, amount,
                    )) => { self._execute_transfer_from(:sender, :token, :amount); },
                    ServerAction::TransferTo((
                        recipient, token, amount,
                    )) => { self._execute_transfer_to(:recipient, :token, :amount); },
                    ServerAction::VerifyValue((
                        storage_address, value,
                    )) => { self._execute_verify_value(:storage_address, :value); },
                };
            };
        }
    }

    #[generate_trait]
    pub impl ServerInternalImpl of ServerInternalTrait {
        fn _execute_write(
            ref self: ContractState,
            storage_address: felt252,
            new_value: felt252,
            require_zero: bool,
        ) {
            let mut target = StorageBase::<Mutable<felt252>> { __base_address__: storage_address };
            let current_value = target.read();
            if require_zero {
                assert(current_value.is_zero(), errors::NON_ZERO_VALUE);
            } else {
                assert(current_value.is_non_zero(), errors::ZERO_VALUE);
            }
            target.write(new_value);
        }

        // TODO: Make generic and consider merging this with `_execute_write` function.
        // TODO: Better naming for this function.
        fn _execute_write_subchannel(
            ref self: ContractState, storage_address: felt252, new_value: EncSubchannelInfo,
        ) {
            let mut target = StorageBase::<
                Mutable<EncSubchannelInfo>,
            > { __base_address__: storage_address };
            let current_value = target.read();
            // TODO: Require zero as param?
            // Require zero.
            assert(current_value.is_zero(), errors::NON_ZERO_VALUE);
            target.write(new_value);
        }

        // TODO: Make generic and consider merging this with `_execute_write` function.
        // TODO: Better naming for this function.
        fn _execute_write_private_key(
            ref self: ContractState,
            storage_address: felt252,
            new_value: EncPrivateKey,
            require_zero: bool,
        ) {
            let mut target = StorageBase::<
                Mutable<EncPrivateKey>,
            > { __base_address__: storage_address };
            let current_value = target.read();
            if require_zero {
                assert(current_value.is_zero(), errors::NON_ZERO_VALUE);
            } else {
                assert(current_value.is_non_zero(), errors::ZERO_VALUE);
            }
            target.write(new_value);
        }

        // TODO: Make generic.
        fn _execute_append_to_vector(
            ref self: ContractState, key: (ContractAddress, felt252), value: EncChannelInfo,
        ) {
            self.recipient_channels.entry(key).push(value);
        }

        fn _execute_transfer_from(
            ref self: ContractState, sender: ContractAddress, token: ContractAddress, amount: u128,
        ) {
            IERC20Dispatcher { contract_address: token }
                .checked_transfer_from(
                    :sender, recipient: get_contract_address(), amount: amount.into(),
                );
        }

        fn _execute_transfer_to(
            ref self: ContractState,
            recipient: ContractAddress,
            token: ContractAddress,
            amount: u128,
        ) {
            IERC20Dispatcher { contract_address: token }
                .checked_transfer(:recipient, amount: amount.into());
        }

        fn _execute_verify_value(
            ref self: ContractState, storage_address: felt252, value: felt252,
        ) {
            let target = StorageBase::<Mutable<felt252>> { __base_address__: storage_address };
            let current_value = target.read();
            assert(current_value == value, errors::VALUE_MISMATCH);
        }
    }

    #[abi(embed_v0)]
    pub impl ViewsImpl of IViews<ContractState> {
        fn channel_exists(self: @ContractState, channel_id: felt252) -> bool {
            self.channel_exists.read(channel_id)
        }

        fn get_num_of_channels(
            self: @ContractState, recipient_addr: ContractAddress, recipient_public_key: felt252,
        ) -> u64 {
            // TODO: Restrict access to `recipient_addr`?
            // TODO: Assert `recipient_addr` is registered?
            self.recipient_channels.entry((recipient_addr, recipient_public_key)).len()
        }

        fn get_channel_info(
            self: @ContractState,
            recipient_addr: ContractAddress,
            recipient_public_key: felt252,
            channel_index: u64,
        ) -> EncChannelInfo {
            // TODO: Restrict access to `recipient_addr`?
            // TODO: Assert `recipient_addr` is registered?
            // TODO: Consider defining custom error instead of using `at` (with "Index out of
            // bounds" error)?
            self
                .recipient_channels
                .entry((recipient_addr, recipient_public_key))
                .at(channel_index)
                .read()
        }

        fn subchannel_exists(self: @ContractState, subchannel_id: felt252) -> bool {
            self.subchannel_exists.read(subchannel_id)
        }

        fn get_subchannel_info(self: @ContractState, subchannel_key: felt252) -> EncSubchannelInfo {
            self.subchannel_tokens.read(subchannel_key)
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

        fn get_enc_private_key(self: @ContractState, user_addr: ContractAddress) -> EncPrivateKey {
            // TODO: Restrict access to compliance?
            // TODO: Assert `user_addr` is registered?
            self.enc_private_key.read(user_addr)
        }

        fn get_compliance_public_key(self: @ContractState) -> felt252 {
            self.compliance_public_key.read()
        }
    }
}
