#[starknet::contract(account)]
pub mod Privacy {
    use core::iter::Extend;
    use core::num::traits::Zero;
    use openzeppelin::access::accesscontrol::AccessControlComponent;
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::token::erc20::interface::IERC20Dispatcher;
    use privacy::actions::{
        AppendToVecInput, ClientAction, ClientActionTrait, CreateEncNoteInput, CreateOpenNoteInput,
        DepositInput, OpenChannelInput, OpenSubchannelInput, ServerAction, SetViewingKeyInput,
        TransferFromInput, TransferToInput, UseNoteInput, VerifyValueInput, WithdrawInput,
        WriteOnceInput,
    };
    use privacy::errors::internal_errors;
    use privacy::hashes::{
        compute_channel_id, compute_channel_key, compute_note_id, compute_nullifier,
        compute_outgoing_channel_key, compute_subchannel_id, compute_subchannel_key,
    };
    use privacy::interface::{IClient, ICompliance, IServer, IViews};
    use privacy::objects::{
        EncChannelInfo, EncChannelInfoTrait, EncOutgoingChannelInfo, EncPrivateKey,
        EncPrivateKeyTrait, EncSubchannelInfo, EncUserAddrTrait, Note, NoteTrait,
        ToServerActionsTrait, TokenBalances, TokenBalancesTrait,
    };
    use privacy::utils::constants::{ENC_NOTE_MIN_SALT, TWO_POW_120};
    use privacy::utils::{
        StoragePathIntoFelt, assert_note_creation_params, assert_valid_execution_info,
        assert_valid_signature, decode_note_amount, derive_public_key, encrypt_channel_info,
        encrypt_outgoing_channel_info, encrypt_private_key, encrypt_subchannel_info,
        encrypt_user_addr, is_canonical_key, panic_with_server_actions, send_message_to_server,
        unwrap_execute_and_panic_result,
    };
    use privacy::{errors, events};
    use starknet::storage::{
        Map, Mutable, MutableVecTrait, StorageBase, StorageMapReadAccess, StoragePathEntry,
        StoragePointerReadAccess, StoragePointerWriteAccess, Vec, VecTrait,
    };
    use starknet::storage_access::{
        StorageBaseAddress, storage_address_from_base_and_offset, storage_base_address_from_felt252,
    };
    use starknet::syscalls::{call_contract_syscall, storage_read_syscall, storage_write_syscall};
    use starknet::{
        ContractAddress, SyscallResultTrait, VALIDATED, get_contract_address, get_execution_info,
    };
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
        channel_exists: Map<felt252, bool>,
        /// Map of subchannel keys to their encrypted tokens.
        subchannel_tokens: Map<felt252, EncSubchannelInfo>,
        /// Map of subchannel id to whether it exists.
        subchannel_exists: Map<felt252, bool>,
        /// Map of note ids to their note information.
        notes: Map<felt252, Note>,
        /// Map of nullifier to whether it exists.
        nullifiers: Map<felt252, bool>,
        /// Map of user addresses to their public viewing keys.
        public_key: Map<ContractAddress, felt252>,
        /// Map of user addresses to their encrypted private key.
        enc_private_key: Map<ContractAddress, EncPrivateKey>,
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
        Deposit: events::Deposit,
        CompliancePublicKeySet: events::CompliancePublicKeySet,
    }

    #[constructor]
    pub(crate) fn constructor(
        ref self: ContractState, governance_admin: ContractAddress, compliance_public_key: felt252,
    ) {
        self.roles.initialize(:governance_admin);
        self.replaceability.initialize(upgrade_delay: Zero::zero());
        self._set_compliance_public_key(:compliance_public_key);
    }

    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;
    #[abi(embed_v0)]
    impl ReplaceabilityImpl =
        ReplaceabilityComponent::ReplaceabilityImpl<ContractState>;
    #[abi(embed_v0)]
    impl RolesImpl = RolesComponent::RolesImpl<ContractState>;

    #[abi(embed_v0)]
    pub impl ClientImpl of IClient<ContractState> {
        fn __validate__(
            self: @ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            client_actions: Span<ClientAction>,
        ) -> felt252 {
            VALIDATED
        }

        fn __execute__(
            ref self: ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            client_actions: Span<ClientAction>,
        ) {
            let execution_info = get_execution_info();
            assert_valid_execution_info(:execution_info);
            let server_actions = self.execute_view(:user_addr, :user_private_key, :client_actions);
            assert_valid_signature(:user_addr, tx_info: execution_info.tx_info);
            send_message_to_server(:server_actions);
        }

        fn execute_view(
            self: @ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            client_actions: Span<ClientAction>,
        ) -> Span<ServerAction> {
            let mut calldata = array![];
            user_addr.serialize(ref calldata);
            user_private_key.serialize(ref calldata);
            client_actions.serialize(ref calldata);
            let syscall_result = call_contract_syscall(
                address: get_contract_address(),
                entry_point_selector: selector!("execute_and_panic"),
                calldata: calldata.span(),
            );

            let mut serialized_server_actions = unwrap_execute_and_panic_result(:syscall_result);
            Serde::deserialize(ref serialized_server_actions)
                .expect(internal_errors::DESERIALIZE_FAILED)
        }

        /// Panics directly for internal errors; external calls should be wrapped via syscall
        /// to prevent injection of `OK_WRAPPER` into the panic data.
        fn execute_and_panic(
            ref self: ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            client_actions: Span<ClientAction>,
        ) {
            assert(user_addr.is_non_zero(), errors::ZERO_USER_ADDR);
            assert(user_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
            assert(is_canonical_key(key: user_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);
            let server_actions = self.main(:user_addr, :user_private_key, :client_actions);
            panic_with_server_actions(:server_actions);
        }
    }

    #[generate_trait]
    pub(crate) impl ClientInternalImpl of ClientInternalTrait {
        /// Assumes `user_addr` is non-zero and `user_private_key` is non-zero and canonical
        /// (checked in `execute_and_panic`).
        fn main(
            ref self: ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            client_actions: Span<ClientAction>,
        ) -> Span<ServerAction> {
            let mut server_actions: Array<ServerAction> = array![];
            let mut current_phase = ClientActionTrait::ACCOUNT_PHASE;
            let mut token_balances: TokenBalances = Default::default();
            // Used to make sure a storage action was included in the client actions.
            let mut has_privacy_action = false;
            for client_action in client_actions {
                client_action.assert_and_set_phase(ref :current_phase);
                let (actions, should_execute) = match *client_action {
                    ClientAction::SetViewingKey(input) => (
                        self.set_viewing_key(:user_addr, :user_private_key, :input), true,
                    ),
                    ClientAction::OpenChannel(input) => (
                        self
                            .open_channel(
                                sender_addr: user_addr,
                                sender_private_key: user_private_key,
                                :input,
                            ),
                        true,
                    ),
                    ClientAction::OpenSubchannel(input) => (
                        self.open_subchannel(sender_addr: user_addr, :input), true,
                    ),
                    ClientAction::Deposit(input) => (
                        self.deposit(:user_addr, :input, ref :token_balances), false,
                    ),
                    ClientAction::CreateEncNote(input) => (
                        self
                            .create_enc_note(
                                sender_addr: user_addr,
                                sender_private_key: user_private_key,
                                :input,
                                ref :token_balances,
                            ),
                        true,
                    ),
                    ClientAction::CreateOpenNote(input) => (
                        self
                            .create_open_note(
                                sender_addr: user_addr,
                                sender_private_key: user_private_key,
                                :input,
                            ),
                        true,
                    ),
                    ClientAction::UseNote(input) => (
                        self
                            .use_note(
                                owner_addr: user_addr,
                                owner_private_key: user_private_key,
                                :input,
                                ref :token_balances,
                            ),
                        true,
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

            server_actions.span()
        }

        /// Assumes `user_addr` is non-zero and `user_private_key` is non-zero and canonical
        /// (checked in `execute_and_panic`).
        fn set_viewing_key(
            self: @ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            input: SetViewingKeyInput,
        ) -> Array<ServerAction> {
            let random = input.random;
            assert(random.is_non_zero(), errors::ZERO_RANDOM);

            // Derive the public key from the private key.
            let user_public_key = derive_public_key(private_key: user_private_key);
            assert(user_public_key.is_non_zero(), internal_errors::ZERO_DERIVED_PUBLIC_KEY);

            // Encrypt the private key for the compliance.
            let enc_private_key = encrypt_private_key(
                ephemeral_secret: random,
                compliance_public_key: self.compliance_public_key.read(),
                private_key: user_private_key,
            );
            assert(enc_private_key.is_all_non_zero(), internal_errors::ZERO_ENC_PRIVATE_KEY);

            array![
                user_public_key
                    .to_write_once_action(storage_address: self.public_key.entry(user_addr).into()),
                enc_private_key
                    .to_write_once_action(
                        storage_address: self.enc_private_key.entry(user_addr).into(),
                    ),
                ServerAction::EmitViewingKeySet(
                    events::ViewingKeySet {
                        user_addr, public_key: user_public_key, enc_private_key,
                    },
                ),
            ]
        }

        /// Assumes `sender_addr` is non-zero and `sender_private_key` is non-zero and canonical
        /// (checked in `execute_and_panic`).
        fn open_channel(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            input: OpenChannelInput,
        ) -> Array<ServerAction> {
            let recipient_addr = input.recipient_addr;
            let recipient_public_key = input.recipient_public_key;
            let index = input.index;
            let random = input.random;
            let salt = input.salt;
            assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
            assert(recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
            assert(random.is_non_zero(), errors::ZERO_RANDOM);

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
            assert(enc_channel_info.is_all_non_zero(), internal_errors::ZERO_ENC_CHANNEL_INFO);
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
                ServerAction::WriteOnce(
                    WriteOnceInput {
                        storage_address: self.channel_exists.entry(channel_id).into(),
                        value: [true.into()].span(),
                    },
                ),
                ServerAction::AppendToVec(AppendToVecInput { recipient_addr, enc_channel_info }),
                enc_outgoing_channel_info
                    .to_write_once_action(
                        storage_address: self.outgoing_channels.entry(outgoing_channel_key).into(),
                    ),
            ]
        }

        /// Assumes `sender_addr` is non-zero (checked in `execute_and_panic`).
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
                ServerAction::WriteOnce(
                    WriteOnceInput {
                        storage_address: self.subchannel_exists.entry(subchannel_id).into(),
                        value: [true.into()].span(),
                    },
                ),
                enc_subchannel_info
                    .to_write_once_action(
                        storage_address: self.subchannel_tokens.entry(subchannel_key).into(),
                    ),
            ]
        }

        /// Assumes `user_addr` is non-zero (checked in `execute_and_panic`).
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
                ServerAction::EmitDeposit(events::Deposit { user_addr, token, amount }),
            ]
        }

        /// Assumes `user_addr` is non-zero (checked in `execute_and_panic`).
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
            assert(enc_user_addr.is_all_non_zero(), internal_errors::ZERO_ENC_USER_ADDR);

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
        /// Assumes `owner_addr` is non-zero and `owner_private_key` is non-zero and canonical
        /// (checked in `execute_and_panic`).
        fn use_note(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            input: UseNoteInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            let channel_key = input.channel_key;
            let token = input.token;
            let index = input.note_index;
            assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY);
            assert(token.is_non_zero(), errors::ZERO_TOKEN);

            // Assert subchannel exists and is connected to owner's address and public key.
            let recipient_public_key = derive_public_key(private_key: owner_private_key);
            let subchannel_id = compute_subchannel_id(
                :channel_key, recipient_addr: owner_addr, :recipient_public_key, :token,
            );
            assert(self.subchannel_exists.read(subchannel_id), errors::SUBCHANNEL_NOT_FOUND);

            // Compute note id.
            let note_id = compute_note_id(:channel_key, :token, :index);

            // Read note from storage and assert it exists.
            let packed_value = self.notes.entry(note_id).packed_value.read();
            assert(packed_value.is_non_zero(), errors::NOTE_NOT_FOUND);

            // Decode note amount (handles both open and encrypted notes).
            // TODO: Test open notes with value when server action is implemented.
            let amount = decode_note_amount(:packed_value, :channel_key, :token, :index);

            // Compute nullifier.
            let nullifier = compute_nullifier(:channel_key, :token, :index, :owner_private_key);

            assert(nullifier.is_non_zero(), internal_errors::ZERO_NULLIFIER);

            token_balances.add_balance(:token, :amount);

            array![
                ServerAction::WriteOnce(
                    WriteOnceInput {
                        storage_address: self.nullifiers.entry(nullifier).into(),
                        value: [true.into()].span(),
                    },
                ),
            ]
        }

        /// Returns the server action to create a note.
        /// Assumes `sender_addr` is non-zero and `sender_private_key` is non-zero and canonical
        /// (checked in `execute_and_panic`).
        fn create_enc_note(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            input: CreateEncNoteInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            let recipient_addr = input.recipient_addr;
            let recipient_public_key = input.recipient_public_key;
            let token = input.token;
            let amount = input.amount;
            let index = input.index;
            let salt = input.salt;

            // Validate inputs.
            assert_note_creation_params(:recipient_addr, :recipient_public_key, :token);
            assert(salt >= ENC_NOTE_MIN_SALT, errors::SALT_TOO_SMALL);
            assert(salt < TWO_POW_120, errors::SALT_EXCEEDS_120_BITS);

            // Validate and compute note values.
            let (channel_key, storage_address) = self
                .prepare_note_creation(
                    :sender_addr,
                    :sender_private_key,
                    :recipient_addr,
                    :recipient_public_key,
                    :token,
                    :index,
                );

            token_balances.subtract_balance(:token, :amount);
            let note = NoteTrait::enc_note(:channel_key, :token, :index, :salt, :amount);
            assert(note.packed_value.is_non_zero(), internal_errors::ZERO_NOTE_VALUE);

            // Only `packed_value` needs to be written, `token` is initialized to zero.
            array![note.packed_value.to_write_once_action(:storage_address)]
        }

        /// Returns the server action to create an open note.
        /// Assumes `owner_addr` is non-zero (checked in `__execute__`).
        fn create_open_note(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            input: CreateOpenNoteInput,
        ) -> Array<ServerAction> {
            let recipient_addr = input.recipient_addr;
            let recipient_public_key = input.recipient_public_key;
            let token = input.token;
            let index = input.index;
            let depositor = input.depositor;

            // Validate inputs.
            assert_note_creation_params(:recipient_addr, :recipient_public_key, :token);
            assert(sender_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
            assert(depositor.is_non_zero(), errors::ZERO_DEPOSITOR);

            // Validate and compute note values.
            let (_, storage_address) = self
                .prepare_note_creation(
                    :sender_addr,
                    :sender_private_key,
                    :recipient_addr,
                    :recipient_public_key,
                    :token,
                    :index,
                );

            let note = NoteTrait::open_note(:token, :depositor);
            assert(note.packed_value.is_non_zero(), internal_errors::ZERO_NOTE_VALUE);

            // TODO: Add event action.
            array![note.to_write_once_action(:storage_address)]
        }

        /// Validates preconditions and computes values needed for creating a note.
        /// Returns `(channel_key, storage_address)`.
        fn prepare_note_creation(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            recipient_addr: ContractAddress,
            recipient_public_key: felt252,
            token: ContractAddress,
            index: usize,
        ) -> (felt252, felt252) {
            let channel_key = compute_channel_key(
                :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key,
            );
            let subchannel_id = compute_subchannel_id(
                :channel_key, :recipient_addr, :recipient_public_key, :token,
            );
            let note_id = compute_note_id(:channel_key, :token, :index);
            let storage_address = self.notes.entry(note_id).into();

            // Assert subchannel exists.
            assert(self.subchannel_exists.read(subchannel_id), errors::SUBCHANNEL_NOT_FOUND);

            // Assert index is sequential, i.e. the previous note exists.
            assert(
                index.is_zero()
                    || self
                        .notes
                        .entry(compute_note_id(:channel_key, :token, index: index - 1))
                        .packed_value
                        .read()
                        .is_non_zero(),
                errors::INDEX_NOT_SEQUENTIAL,
            );

            // Assert note id is valid.
            assert(note_id.is_non_zero(), internal_errors::ZERO_NOTE_ID);

            (channel_key, storage_address)
        }
    }

    #[abi(embed_v0)]
    pub impl ServerImpl of IServer<ContractState> {
        fn execute_actions(ref self: ContractState, actions: Span<ServerAction>) {
            self.pausable.assert_not_paused();
            // TODO: Verify client proof.
            for action in actions {
                match *action {
                    ServerAction::WriteOnce(input) => {
                        self
                            ._execute_write(
                                storage_address: input.storage_address,
                                new_value: input.value,
                                require_zero: true,
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
                    ServerAction::EmitDeposit(event) => { self.emit(event); },
                };
            };
        }
    }

    #[generate_trait]
    pub impl ServerInternalImpl of ServerInternalTrait {
        fn _execute_write(
            ref self: ContractState,
            storage_address: felt252,
            new_value: Span<felt252>,
            require_zero: bool,
        ) {
            let base: StorageBaseAddress = storage_base_address_from_felt252(addr: storage_address);
            let mut offset = 0;
            for value in new_value {
                let address = storage_address_from_base_and_offset(:base, :offset);
                offset += 1;

                if require_zero {
                    assert(
                        storage_read_syscall(address_domain: 0, :address)
                            .unwrap_syscall()
                            .is_zero(),
                        errors::NON_ZERO_VALUE,
                    );
                }
                storage_write_syscall(address_domain: 0, :address, value: *value).unwrap_syscall();
            }
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
            // Note: This function should NOT panic as the contract should have the balance.
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

        // TODO: Consider revising / splitting for open notes.
        fn get_note(self: @ContractState, note_id: felt252) -> felt252 {
            let note = self.notes.read(note_id);
            assert(note.token.is_zero(), internal_errors::ENC_NOTE_NON_ZERO_TOKEN);
            self.notes.read(note_id).packed_value
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

    #[abi(embed_v0)]
    pub impl ComplianceImpl of ICompliance<ContractState> {
        fn set_compliance_public_key(ref self: ContractState, compliance_public_key: felt252) {
            // TODO: Change to the real role.
            self.roles.only_token_admin();
            self._set_compliance_public_key(:compliance_public_key);
        }
    }

    #[generate_trait]
    impl ComplianceInternalImpl of ComplianceInternalTrait {
        fn _set_compliance_public_key(ref self: ContractState, compliance_public_key: felt252) {
            assert(compliance_public_key.is_non_zero(), errors::ZERO_COMPLIANCE_PUBLIC_KEY);
            self.compliance_public_key.write(compliance_public_key);
            self.emit(events::CompliancePublicKeySet { compliance_public_key });
        }
    }
}
