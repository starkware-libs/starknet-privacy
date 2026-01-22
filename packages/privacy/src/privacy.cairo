#[starknet::contract(account)]
pub mod Privacy {
    use core::iter::Extend;
    use core::num::traits::Zero;
    use openzeppelin::access::accesscontrol::AccessControlComponent;
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::token::erc20::interface::IERC20Dispatcher;
    use privacy::actions::{
        AppendToVecInput, ClientAction, ClientActionTrait, CreateNoteInput, DepositInput,
        OpenChannelInput, OpenSubchannelInput, ServerAction, SetViewingKeyInput, TransferFromInput,
        TransferToInput, UseNoteInput, VerifyValueInput, WithdrawInput, WriteIfZeroInput,
    };
    use privacy::errors::internal_errors;
    use privacy::hashes::{
        compute_channel_id, compute_channel_key, compute_note_id, compute_nullifier,
        compute_outgoing_channel_key, compute_subchannel_id, compute_subchannel_key,
    };
    use privacy::interface::{IClient, IServer, IViews};
    use privacy::objects::{
        EncChannelInfo, EncChannelInfoTrait, EncOutgoingChannelInfo, EncPrivateKey,
        EncSubchannelInfo, TokenBalances, TokenBalancesTrait,
    };
    use privacy::utils::constants::{ERROR_WRAPPER, OK_WRAPPER, TWO_POW_120};
    use privacy::utils::{
        StoragePathIntoFelt, assert_valid_signature, decrypt_note_amount, derive_public_key,
        encrypt_channel_info, encrypt_note_amount, encrypt_outgoing_channel_info,
        encrypt_private_key, encrypt_subchannel_info, encrypt_user_addr, is_canonical_key,
        send_message_to_server, unwrap_execute_and_panic_result,
    };
    use privacy::{errors, events};
    use starknet::storage::{
        Map, Mutable, MutableVecTrait, StorageBase, StorageMapReadAccess, StoragePathEntry,
        StoragePointerReadAccess, StoragePointerWriteAccess, Vec, VecTrait,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, VALIDATED, get_caller_address, get_contract_address};
    use starkware_utils::components::pausable::PausableComponent;
    use starkware_utils::components::replaceability::ReplaceabilityComponent;
    use starkware_utils::components::replaceability::ReplaceabilityComponent::InternalReplaceabilityTrait;
    use starkware_utils::components::roles::RolesComponent;
    use starkware_utils::components::roles::RolesComponent::InternalTrait as RolesInternalTrait;
    use starkware_utils::erc20::erc20_utils::CheckedIERC20DispatcherTrait;

    component!(path: PausableComponent, storage: pausable, event: PausableEvent);
    component!(path: ReplaceabilityComponent, storage: replaceability, event: ReplaceabilityEvent);
    component!(path: RolesComponent, storage: roles, event: RolesEvent);
    component!(path: AccessControlComponent, storage: accesscontrol, event: AccessControlEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);

    #[storage]
    struct Storage {
        #[substorage(v0)]
        pausable: PausableComponent::Storage,
        #[substorage(v0)]
        replaceability: ReplaceabilityComponent::Storage,
        #[substorage(v0)]
        roles: RolesComponent::Storage,
        #[substorage(v0)]
        accesscontrol: AccessControlComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        /// Map of recipient_addr to a list of their encrypted channels.
        recipient_channels: Map<ContractAddress, Vec<EncChannelInfo>>,
        /// Map of outgoing-channel keys to their encrypted recipient addresses.
        outgoing_channels: Map<felt252, EncOutgoingChannelInfo>,
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
    pub enum Event {
        #[flat]
        PausableEvent: PausableComponent::Event,
        #[flat]
        ReplaceabilityEvent: ReplaceabilityComponent::Event,
        #[flat]
        RolesEvent: RolesComponent::Event,
        #[flat]
        AccessControlEvent: AccessControlComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        ViewingKeySet: events::ViewingKeySet,
        Withdrawal: events::Withdrawal,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState, governance_admin: ContractAddress, compliance_public_key: felt252,
    ) {
        self.roles.initialize(:governance_admin);
        self.replaceability.initialize(upgrade_delay: Zero::zero());
        self.compliance_public_key.write(compliance_public_key);
    }

    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;
    #[abi(embed_v0)]
    impl ReplaceabilityImpl =
        ReplaceabilityComponent::ReplaceabilityImpl<ContractState>;
    #[abi(embed_v0)]
    impl RolesImpl = RolesComponent::RolesImpl<ContractState>;

    // TODO: Consider all randoms to be u128/120 bits.
    #[abi(embed_v0)]
    pub impl ClientImpl of IClient<ContractState> {
        fn __validate__(
            self: @ContractState, user_addr: ContractAddress, client_actions: Span<ClientAction>,
        ) -> felt252 {
            VALIDATED
        }

        // TODO: Gets a single random and generate from it new randoms for each action that needs a
        // random.
        fn __execute__(
            ref self: ContractState, user_addr: ContractAddress, client_actions: Span<ClientAction>,
        ) {
            assert(get_caller_address().is_zero(), errors::INVALID_CALLER);
            assert(user_addr.is_non_zero(), errors::ZERO_USER_ADDR);
            let mut calldata = array![];
            user_addr.serialize(ref calldata);
            client_actions.serialize(ref calldata);
            let syscall_result = call_contract_syscall(
                address: get_contract_address(),
                entry_point_selector: selector!("execute_and_panic"),
                calldata: calldata.span(),
            );

            let mut serialized_server_actions = unwrap_execute_and_panic_result(:syscall_result);
            let server_actions = Serde::deserialize(ref serialized_server_actions)
                .expect(internal_errors::DESERIALIZE_FAILED);
            send_message_to_server(:server_actions);
        }

        /// Panics directly for internal errors; external calls are wrapped via syscall
        /// to wrap their panics with `ERROR_WRAPPER`.
        // TODO: Add tests (verify always panics with appropriate wrapping).
        fn execute_and_panic(
            ref self: ContractState, user_addr: ContractAddress, client_actions: Span<ClientAction>,
        ) {
            // TODO: Consider extracting logic to internal `main` function.
            // TODO: Consider asserting that `client_actions` is not empty.
            let mut server_actions: Array<ServerAction> = array![];
            let mut current_phase = ClientActionTrait::ACCOUNT_PHASE;
            let mut token_balances: TokenBalances = Default::default();
            // Used to make sure a storage action was included in the client actions.
            let mut has_privacy_action = false;
            for client_action in client_actions {
                client_action.assert_and_set_phase(ref :current_phase);
                // TODO: Consider renaming `should_execute`.
                let (actions, should_execute) = match *client_action {
                    ClientAction::SetViewingKey(input) => (
                        self.set_viewing_key(:user_addr, :input), true,
                    ),
                    ClientAction::OpenChannel(input) => (
                        self.open_channel(sender_addr: user_addr, :input), true,
                    ),
                    ClientAction::OpenSubchannel(input) => (
                        self.open_subchannel(sender_addr: user_addr, :input), true,
                    ),
                    ClientAction::Deposit(input) => (
                        self.deposit(:user_addr, :input, ref :token_balances), false,
                    ),
                    ClientAction::CreateNote(input) => (
                        self.create_note(owner_addr: user_addr, :input, ref :token_balances), true,
                    ),
                    ClientAction::UseNote(input) => (
                        self.use_note(owner_addr: user_addr, :input, ref :token_balances), true,
                    ),
                    ClientAction::Withdraw(input) => (
                        self.withdraw(:user_addr, :input, ref :token_balances), false,
                    ),
                };
                if should_execute {
                    has_privacy_action = true;
                    self.execute_actions(actions.span());
                }
                server_actions.extend(actions);
            }
            assert(has_privacy_action, errors::NO_PRIVACY_ACTIONS);
            token_balances.squash().assert_valid();

            let mut panic_message = array![];
            // `assert_valid_signature` must be the last call before panicking, to ensure contract
            // storage is not modified.
            // TODO: Consider refactoring wrapping logic to a function.
            // TODO: Test wrapped `is_valid_signature` panics.
            if let Err(err) = assert_valid_signature(:user_addr) {
                panic_message.append(ERROR_WRAPPER);
                panic_message.extend(err);
                panic_message.append(ERROR_WRAPPER);
            } else {
                panic_message.append(OK_WRAPPER);
                server_actions.serialize(ref panic_message);
                panic_message.append(OK_WRAPPER);
            }
            panic(panic_message);
        }
    }

    #[generate_trait]
    pub(crate) impl ClientInternalImpl of ClientInternalTrait {
        /// Assumes `user_addr` is non-zero (checked in `compile_client_actions`).
        fn set_viewing_key(
            self: @ContractState, user_addr: ContractAddress, input: SetViewingKeyInput,
        ) -> Array<ServerAction> {
            let private_key = input.private_key;
            let random = input.random;
            assert(private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
            assert(random.is_non_zero(), errors::ZERO_RANDOM);
            assert(is_canonical_key(key: private_key), errors::PRIVATE_KEY_NOT_CANONICAL);

            // Derive the public key from the private key.
            let user_public_key = derive_public_key(:private_key);
            assert(user_public_key.is_non_zero(), internal_errors::ZERO_DERIVED_PUBLIC_KEY);

            // Encrypt the private key for the compliance.
            let enc_private_key = encrypt_private_key(
                ephemeral_secret: random,
                compliance_public_key: self.compliance_public_key.read(),
                :private_key,
            );
            assert(enc_private_key.is_non_zero(), internal_errors::ZERO_ENC_PRIVATE_KEY);

            array![
                ServerAction::WriteIfZero(
                    WriteIfZeroInput {
                        storage_address: self.public_key.entry(user_addr).into(),
                        value: user_public_key,
                    },
                ),
                ServerAction::WriteIfZeroPrivateKey(
                    WriteIfZeroInput {
                        storage_address: self.enc_private_key.entry(user_addr).into(),
                        value: enc_private_key,
                    },
                ),
                ServerAction::EmitViewingKeySet(
                    events::ViewingKeySet {
                        user_addr, public_key: user_public_key, enc_private_key,
                    },
                ),
            ]
        }

        /// Assumes `sender_addr` is non-zero (checked in `compile_client_actions`).
        fn open_channel(
            self: @ContractState, sender_addr: ContractAddress, input: OpenChannelInput,
        ) -> Array<ServerAction> {
            let sender_private_key = input.sender_private_key;
            let recipient_addr = input.recipient_addr;
            let recipient_public_key = input.recipient_public_key;
            let index = input.index;
            let random = input.random;
            let salt = input.salt;
            assert(sender_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
            assert(random.is_non_zero(), errors::ZERO_RANDOM);

            // Assert sender private key is canonical.
            assert(is_canonical_key(key: sender_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);

            // Assert sender is registered with the given private key.
            let sender_public_key = self.public_key.read(sender_addr);
            assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
            assert(
                sender_public_key == derive_public_key(private_key: sender_private_key),
                errors::SENDER_NOT_AUTHENTICATED,
            );

            // Assert index is sequential, i.e. the previous channel exists.
            assert(
                index.is_zero()
                    || self
                        .outgoing_channels
                        .read(
                            compute_outgoing_channel_key(
                                :sender_addr, :sender_private_key, index: index - 1,
                            ),
                        )
                        .is_non_zero(),
                errors::INDEX_NOT_SEQUENTIAL,
            );

            // Compute the output values.
            let channel_key = compute_channel_key(
                :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key,
            );
            assert(channel_key.is_non_zero(), internal_errors::UNEXPECTED_ZERO_CHANNEL_KEY);
            let enc_channel_info = encrypt_channel_info(
                ephemeral_secret: random, :recipient_public_key, :channel_key, :sender_addr,
            );
            let channel_id = compute_channel_id(
                :channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
            );
            let outgoing_channel_key = compute_outgoing_channel_key(
                :sender_addr, :sender_private_key, :index,
            );
            let enc_outgoing_channel_info = encrypt_outgoing_channel_info(
                :sender_addr, :sender_private_key, :index, :recipient_addr, :salt,
            );

            assert(channel_id.is_non_zero(), internal_errors::ZERO_CHANNEL_ID);
            assert(enc_channel_info.is_non_zero(), internal_errors::ZERO_ENC_CHANNEL_INFO);
            assert(outgoing_channel_key.is_non_zero(), internal_errors::ZERO_OUTGOING_CHANNEL_KEY);
            assert(
                enc_outgoing_channel_info.is_non_zero(),
                internal_errors::ZERO_ENC_OUTGOING_CHANNEL_INFO,
            );

            array![
                ServerAction::VerifyValue(
                    VerifyValueInput {
                        storage_address: self.public_key.entry(recipient_addr).into(),
                        value: recipient_public_key,
                    },
                ),
                ServerAction::WriteIfZero(
                    WriteIfZeroInput {
                        storage_address: self.channel_exists.entry(channel_id).into(),
                        value: true.into(),
                    },
                ),
                ServerAction::AppendToVec(AppendToVecInput { recipient_addr, enc_channel_info }),
                ServerAction::WriteIfZeroOutgoingChannel(
                    WriteIfZeroInput {
                        storage_address: self.outgoing_channels.entry(outgoing_channel_key).into(),
                        value: enc_outgoing_channel_info,
                    },
                ),
            ]
        }

        /// Assumes `sender_addr` is non-zero (checked in `compile_client_actions`).
        fn open_subchannel(
            self: @ContractState, sender_addr: ContractAddress, input: OpenSubchannelInput,
        ) -> Array<ServerAction> {
            let recipient_addr = input.recipient_addr;
            let recipient_public_key = input.recipient_public_key;
            let channel_key = input.channel_key;
            let index = input.index;
            let token = input.token;
            let salt = input.salt;
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
            assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);

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
            let enc_subchannel_info = encrypt_subchannel_info(:channel_key, :index, :token, :salt);
            assert(subchannel_id.is_non_zero(), internal_errors::ZERO_SUBCHANNEL_ID);
            assert(subchannel_key.is_non_zero(), internal_errors::ZERO_SUBCHANNEL_KEY);
            assert(enc_subchannel_info.is_non_zero(), internal_errors::ZERO_ENC_SUBCHANNEL_TOKEN);

            array![
                ServerAction::WriteIfZero(
                    WriteIfZeroInput {
                        storage_address: self.subchannel_exists.entry(subchannel_id).into(),
                        value: true.into(),
                    },
                ),
                ServerAction::WriteIfZeroSubchannel(
                    WriteIfZeroInput {
                        storage_address: self.subchannel_tokens.entry(subchannel_key).into(),
                        value: enc_subchannel_info,
                    },
                ),
            ]
        }

        /// Assumes `user_addr` is non-zero (checked in `compile_client_actions`).
        fn deposit(
            self: @ContractState,
            user_addr: ContractAddress,
            input: DepositInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            // Assert input is valid.
            let token = input.token;
            let amount = input.amount;
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);

            token_balances.add_balance(:token, :amount);

            array![
                ServerAction::TransferFrom(
                    TransferFromInput { sender_addr: user_addr, token, amount },
                ),
            ]
        }

        fn withdraw(
            self: @ContractState,
            user_addr: ContractAddress,
            input: WithdrawInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            let withdrawal_target = input.withdrawal_target;
            let token = input.token;
            let amount = input.amount;
            let random = input.random;
            // Assert valid input.
            assert(withdrawal_target.is_non_zero(), errors::ZERO_WITHDRAWAL_TARGET);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(random.is_non_zero(), errors::ZERO_RANDOM);

            token_balances.subtract_balance(:token, :amount);

            // Encrypt the user address for the compliance.
            let enc_user_addr = encrypt_user_addr(
                ephemeral_secret: random,
                compliance_public_key: self.compliance_public_key.read(),
                :user_addr,
            );

            array![
                ServerAction::TransferTo(
                    TransferToInput { recipient_addr: withdrawal_target, token, amount },
                ),
                ServerAction::EmitWithdrawal(
                    events::Withdrawal { enc_user_addr, withdrawal_target, token, amount },
                ),
            ]
        }

        /// Returns the server action to use a note.
        /// Assumes `owner_addr` is non-zero (checked in `compile_client_actions`).
        fn use_note(
            self: @ContractState,
            owner_addr: ContractAddress,
            input: UseNoteInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            let owner_private_key = input.owner_private_key;
            let channel_key = input.channel_key;
            let token = input.token;
            let index = input.note_index;
            // TODO: Consider adding context to the errors (which note is causing the error).
            assert(owner_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
            assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(is_canonical_key(key: owner_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);

            // Assert subchannel exists and is connected to owner's address and public key.
            let recipient_public_key = derive_public_key(private_key: owner_private_key);
            let subchannel_id = compute_subchannel_id(
                :channel_key, recipient_addr: owner_addr, :recipient_public_key, :token,
            );
            assert(self.subchannel_exists.read(subchannel_id), errors::SUBCHANNEL_NOT_FOUND);

            // Compute note id.
            let note_id = compute_note_id(:channel_key, :token, :index);

            // Read note from storage and assert it exists.
            let enc_note_value = self.notes.read(note_id);
            assert(enc_note_value.is_non_zero(), errors::NOTE_NOT_FOUND);

            // Decrypt note amount.
            let amount = decrypt_note_amount(:enc_note_value, :channel_key, :token, :index);
            assert(amount.is_non_zero(), internal_errors::UNEXPECTED_ZERO_AMOUNT);

            // Compute nullifier.
            let nullifier = compute_nullifier(:channel_key, :token, :index, :owner_private_key);

            assert(nullifier.is_non_zero(), internal_errors::ZERO_NULLIFIER);

            token_balances.add_balance(:token, :amount);

            array![
                ServerAction::WriteIfZero(
                    WriteIfZeroInput {
                        storage_address: self.nullifiers.entry(nullifier).into(),
                        value: true.into(),
                    },
                ),
            ]
        }

        /// Returns the server action to create a note.
        /// Assumes `owner_addr` is non-zero (checked in `compile_client_actions`).
        fn create_note(
            self: @ContractState,
            owner_addr: ContractAddress,
            input: CreateNoteInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            let sender_private_key = input.sender_private_key;
            let recipient_addr = input.recipient_addr;
            let recipient_public_key = input.recipient_public_key;
            let token = input.token;
            let amount = input.amount;
            let index = input.index;
            let salt = input.salt;
            // TODO: Consider adding context to the errors (which note is causing the error).
            assert(sender_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(is_canonical_key(key: sender_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);
            // Assert salt is 120 bits.
            assert(salt < TWO_POW_120, errors::SALT_EXCEEDS_120_BITS);

            // Compute channel key.
            let channel_key = compute_channel_key(
                sender_addr: owner_addr,
                :sender_private_key,
                :recipient_addr,
                :recipient_public_key,
            );

            // Assert subchannel exists.
            let subchannel_id = compute_subchannel_id(
                :channel_key, :recipient_addr, :recipient_public_key, :token,
            );
            assert(self.subchannel_exists.read(subchannel_id), errors::SUBCHANNEL_NOT_FOUND);

            // Assert index is sequential, i.e. the previous note exists.
            assert(
                index.is_zero()
                    || self
                        .notes
                        .read(compute_note_id(:channel_key, :token, index: index - 1))
                        .is_non_zero(),
                errors::INDEX_NOT_SEQUENTIAL,
            );

            // Compute note values.
            let note_id = compute_note_id(:channel_key, :token, :index);
            let enc_amount = encrypt_note_amount(:channel_key, :token, :index, :salt, :amount);

            assert(note_id.is_non_zero(), internal_errors::ZERO_NOTE_ID);
            assert(enc_amount.is_non_zero(), internal_errors::ZERO_ENC_NOTE_VALUE);

            token_balances.subtract_balance(:token, :amount);

            array![
                ServerAction::WriteIfZero(
                    WriteIfZeroInput {
                        storage_address: self.notes.entry(note_id).into(), value: enc_amount,
                    },
                ),
            ]
        }
    }

    #[abi(embed_v0)]
    pub impl ServerImpl of IServer<ContractState> {
        fn execute_actions(ref self: ContractState, actions: Span<ServerAction>) {
            self.pausable.assert_not_paused();
            // TODO: Verify client proof.
            for action in actions {
                match *action {
                    ServerAction::WriteIfZero(input) => {
                        self
                            ._execute_write(
                                storage_address: input.storage_address,
                                new_value: input.value,
                                require_zero: true,
                            );
                    },
                    ServerAction::WriteIfZeroSubchannel(input) => {
                        self
                            ._execute_write_subchannel(
                                storage_address: input.storage_address, new_value: input.value,
                            );
                    },
                    ServerAction::WriteIfZeroOutgoingChannel(input) => {
                        self
                            ._execute_write_outgoing_channel(
                                storage_address: input.storage_address, new_value: input.value,
                            );
                    },
                    ServerAction::WriteIfZeroPrivateKey(input) => {
                        self
                            ._execute_write_private_key(
                                storage_address: input.storage_address, new_value: input.value,
                            );
                    },
                    ServerAction::AppendToVec(input) => {
                        self
                            ._execute_append_to_vector(
                                key: input.recipient_addr, value: input.enc_channel_info,
                            );
                    },
                    ServerAction::TransferFrom(input) => {
                        self
                            ._execute_transfer_from(
                                sender_addr: input.sender_addr,
                                token: input.token,
                                amount: input.amount,
                            );
                    },
                    ServerAction::TransferTo(input) => {
                        self
                            ._execute_transfer_to(
                                recipient_addr: input.recipient_addr,
                                token: input.token,
                                amount: input.amount,
                            );
                    },
                    ServerAction::VerifyValue(input) => {
                        self
                            ._execute_verify_value(
                                storage_address: input.storage_address, value: input.value,
                            );
                    },
                    ServerAction::EmitViewingKeySet(event) => { self.emit(event); },
                    ServerAction::EmitWithdrawal(event) => { self.emit(event); },
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
            if require_zero {
                assert(target.read().is_zero(), errors::NON_ZERO_VALUE);
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
            // TODO: Fix is zero, should check all fields are non zero.
            assert(current_value.is_zero(), errors::NON_ZERO_VALUE);
            target.write(new_value);
        }

        // TODO: Merge with `_execute_write_subchannel` function.
        fn _execute_write_outgoing_channel(
            ref self: ContractState, storage_address: felt252, new_value: EncOutgoingChannelInfo,
        ) {
            let mut target = StorageBase::<
                Mutable<EncOutgoingChannelInfo>,
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
            ref self: ContractState, storage_address: felt252, new_value: EncPrivateKey,
        ) {
            let mut target = StorageBase::<
                Mutable<EncPrivateKey>,
            > { __base_address__: storage_address };
            let current_value = target.read();
            // TODO: Require zero as param?
            // Require zero.
            // TODO: Fix is zero, should check all fields are non zero.
            assert(current_value.is_zero(), errors::NON_ZERO_VALUE);
            target.write(new_value);
        }

        fn _execute_append_to_vector(
            ref self: ContractState, key: ContractAddress, value: EncChannelInfo,
        ) {
            self.recipient_channels.entry(key).push(value);
        }

        fn _execute_transfer_from(
            ref self: ContractState,
            sender_addr: ContractAddress,
            token: ContractAddress,
            amount: u128,
        ) {
            IERC20Dispatcher { contract_address: token }
                .checked_transfer_from(
                    sender: sender_addr, recipient: get_contract_address(), amount: amount.into(),
                );
        }

        fn _execute_transfer_to(
            ref self: ContractState,
            recipient_addr: ContractAddress,
            token: ContractAddress,
            amount: u128,
        ) {
            IERC20Dispatcher { contract_address: token }
                .checked_transfer(recipient: recipient_addr, amount: amount.into());
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

        fn get_num_of_channels(self: @ContractState, recipient_addr: ContractAddress) -> u64 {
            self.recipient_channels.entry(recipient_addr).len()
        }

        fn get_channel_info(
            self: @ContractState, recipient_addr: ContractAddress, channel_index: u64,
        ) -> EncChannelInfo {
            self.recipient_channels.entry(recipient_addr).at(channel_index).read()
        }

        fn get_outgoing_channel_info(
            self: @ContractState, outgoing_channel_key: felt252,
        ) -> EncOutgoingChannelInfo {
            self.outgoing_channels.read(outgoing_channel_key)
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
            self.enc_private_key.read(user_addr)
        }

        fn get_compliance_public_key(self: @ContractState) -> felt252 {
            self.compliance_public_key.read()
        }
    }
}
