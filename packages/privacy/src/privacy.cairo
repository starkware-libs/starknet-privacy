#[starknet::contract(account)]
pub mod Privacy {
    use core::iter::Extend;
    use core::num::traits::Zero;
    use openzeppelin::access::accesscontrol::AccessControlComponent;
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::security::ReentrancyGuardComponent;
    use privacy::actions::{
        AppendInput, ClientAction, ClientActionTrait, CreateEncNoteInput, CreateOpenNoteInput,
        DepositInput, InputValidation, InvokeExternalInput, InvokeInput, OpenChannelInput,
        OpenSubchannelInput, ServerAction, SetViewingKeyInput, TransferFromInput, TransferToInput,
        UseNoteInput, WithdrawInput, WriteOnceInput,
    };
    use privacy::errors::internal_errors;
    use privacy::hashes::{
        compute_channel_key, compute_channel_marker, compute_note_id, compute_nullifier,
        compute_outgoing_channel_id, compute_subchannel_id, compute_subchannel_marker,
    };
    use privacy::interface::{IAdmin, IClient, IServer, IViews};
    use privacy::objects::{
        EncChannelInfo, EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo, Note,
        OpenNoteDeposit, TokenBalances, TokenBalancesTrait,
    };
    use privacy::utils::constants::{
        INVOKE_SELECTOR, OPEN_NOTE_SALT, STRK_TOKEN_ADDRESS, VIRTUAL_SNOS, VIRTUAL_SNOS0,
    };
    use privacy::utils::{
        ProofFacts, assert_valid_signature, assert_valid_tx_version, compute_message_hash,
        decode_note_amount, derive_public_key, enc_note_packed_value, encrypt_channel_info,
        encrypt_outgoing_channel_info, encrypt_private_key, encrypt_subchannel_info,
        encrypt_user_addr, extract_compile_actions_inputs,
        extract_server_actions_from_compile_and_panic, is_canonical_key, open_note, pack,
        panic_with_server_actions, send_message_to_server, storage_path_to_felt252,
        to_write_once_action, unpack,
    };
    use privacy::{errors, events};
    use starknet::account::Call;
    use starknet::storage::{
        Map, MutableVecTrait, StorageMapReadAccess, StoragePathEntry, StoragePointerReadAccess,
        StoragePointerWriteAccess, Vec, VecTrait,
    };
    use starknet::storage_access::{
        StorageBaseAddress, storage_address_from_base_and_offset, storage_base_address_from_felt252,
    };
    use starknet::syscalls::{
        call_contract_syscall, get_execution_info_v3_syscall, storage_read_syscall,
        storage_write_syscall,
    };
    use starknet::{
        ContractAddress, SyscallResultTrait, VALIDATED, get_caller_address, get_contract_address,
        get_execution_info, get_tx_info,
    };
    use starkware_utils::components::pausable::PausableComponent;
    use starkware_utils::components::replaceability::ReplaceabilityComponent;
    use starkware_utils::components::replaceability::ReplaceabilityComponent::InternalReplaceabilityTrait;
    use starkware_utils::components::roles::RolesComponent;
    use starkware_utils::components::roles::RolesComponent::InternalTrait as RolesInternalTrait;
    use starkware_utils::erc20::erc20_utils::{checked_transfer, checked_transfer_from};

    component!(path: PausableComponent, storage: pausable, event: PausableEvent);
    component!(path: ReplaceabilityComponent, storage: replaceability, event: ReplaceabilityEvent);
    component!(path: RolesComponent, storage: roles, event: RolesEvent);
    component!(path: AccessControlComponent, storage: accesscontrol, event: AccessControlEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(
        path: ReentrancyGuardComponent, storage: reentrancyguard, event: ReentrancyGuardEvent,
    );

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
        #[substorage(v0)]
        reentrancyguard: ReentrancyGuardComponent::Storage,
        /// Map of recipient_addr to a list of their encrypted channels.
        recipient_channels: Map<ContractAddress, Vec<EncChannelInfo>>,
        /// Map of outgoing-channel ids to their encrypted recipient addresses.
        outgoing_channels: Map<felt252, EncOutgoingChannelInfo>,
        /// Map of channel marker to whether it exists.
        channel_exists: Map<felt252, bool>,
        /// Map of subchannel ids to their encrypted tokens.
        subchannel_tokens: Map<felt252, EncSubchannelInfo>,
        /// Map of subchannel marker to whether it exists.
        subchannel_exists: Map<felt252, bool>,
        /// Map of note ids to their note information.
        notes: Map<felt252, Note>,
        /// Map of nullifier to whether it exists.
        nullifiers: Map<felt252, bool>,
        /// Map of user addresses to their public viewing keys.
        public_key: Map<ContractAddress, felt252>,
        /// Map of user addresses to their encrypted private key.
        enc_private_key: Map<ContractAddress, EncPrivateKey>,
        /// Public key of the auditor used for private key encryptions.
        auditor_public_key: felt252,
        /// Fee amount (in FRI) charged per `apply_actions` call.
        fee_amount: u128,
        /// Address that receives the fee.
        fee_collector: ContractAddress,
        /// The number of blocks that a proof is valid for.
        proof_validity_blocks: u64,
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
        #[flat]
        ReentrancyGuardEvent: ReentrancyGuardComponent::Event,
        ViewingKeySet: events::ViewingKeySet,
        Withdrawal: events::Withdrawal,
        Deposit: events::Deposit,
        AuditorPublicKeySet: events::AuditorPublicKeySet,
        OpenNoteCreated: events::OpenNoteCreated,
        EncNoteCreated: events::EncNoteCreated,
        OpenNoteDeposited: events::OpenNoteDeposited,
        NoteUsed: events::NoteUsed,
        FeeAmountSet: events::FeeAmountSet,
        FeeCollectorSet: events::FeeCollectorSet,
        ProofValidityBlocksSet: events::ProofValidityBlocksSet,
    }

    #[constructor]
    pub(crate) fn constructor(
        ref self: ContractState,
        governance_admin: ContractAddress,
        auditor_public_key: felt252,
        proof_validity_blocks: u64,
    ) {
        self.roles.initialize(:governance_admin);
        self.replaceability.initialize(upgrade_delay: Zero::zero());
        self._set_auditor_public_key(:auditor_public_key);
        self._set_proof_validity_blocks(:proof_validity_blocks);
    }

    #[abi(embed_v0)]
    impl PausableImpl = PausableComponent::PausableImpl<ContractState>;
    impl PausableInternalImpl = PausableComponent::InternalImpl<ContractState>;
    impl ReentrancyGuardInternalImpl = ReentrancyGuardComponent::InternalImpl<ContractState>;
    #[abi(embed_v0)]
    impl ReplaceabilityImpl =
        ReplaceabilityComponent::ReplaceabilityImpl<ContractState>;
    #[abi(embed_v0)]
    impl RolesImpl = RolesComponent::RolesImpl<ContractState>;

    #[abi(embed_v0)]
    pub impl ClientImpl of IClient<ContractState> {
        fn __validate__(self: @ContractState, calls: Array<Call>) -> felt252 {
            let tx_info = get_tx_info();
            // Ensure that the effective fee of the transaction is zero.
            assert_valid_tx_version(tx_version: tx_info.version);
            assert(tx_info.tip.is_zero(), errors::NON_ZERO_TIP);
            for resource_bounds in tx_info.resource_bounds {
                assert(
                    resource_bounds.max_price_per_unit.is_zero(), errors::NON_ZERO_RESOURCE_PRICE,
                );
            }
            VALIDATED
        }

        fn __execute__(ref self: ContractState, calls: Array<Call>) {
            let execution_info = get_execution_info();
            let tx_info = execution_info.tx_info;
            // Ensure that the current call is the first of the transaction,
            // (by checking that the caller address is zero and disabling V0 meta tx syscalls).
            assert(execution_info.caller_address.is_zero(), errors::NON_ZERO_CALLER);
            assert_valid_tx_version(tx_version: tx_info.version);

            let (user_addr, user_private_key, client_actions) = extract_compile_actions_inputs(
                :calls, contract_address: execution_info.contract_address,
            );
            let server_actions = self
                .compile_actions(:user_addr, :user_private_key, :client_actions);
            assert_valid_signature(:user_addr, :tx_info);
            send_message_to_server(
                :server_actions, contract_address: execution_info.contract_address,
            );
        }

        fn compile_actions(
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
                entry_point_selector: selector!("compile_and_panic"),
                calldata: calldata.span(),
            );

            extract_server_actions_from_compile_and_panic(:syscall_result)
        }

        /// Panics directly for internal errors; external calls should be wrapped via syscall
        /// to prevent injection of `OK_WRAPPER` into the panic data.
        fn compile_and_panic(
            ref self: ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            client_actions: Span<ClientAction>,
        ) {
            let server_actions = self.main(:user_addr, :user_private_key, :client_actions);
            panic_with_server_actions(:server_actions);
        }
    }

    #[generate_trait]
    pub(crate) impl ClientInternalImpl of ClientInternalTrait {
        /// Processes a sequence of client actions and returns the corresponding server actions.
        /// Validates action phases, tracks token balances, and ensures at least one privacy action
        /// is included.
        fn main(
            ref self: ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            client_actions: Span<ClientAction>,
        ) -> Span<ServerAction> {
            // Assert input is valid.
            assert(user_addr.is_non_zero(), errors::ZERO_USER_ADDR);
            assert(user_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
            assert(is_canonical_key(key: user_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);

            let mut server_actions: Array<ServerAction> = array![];
            let mut curr_phase = ClientActionTrait::ACCOUNT_PHASE;
            let mut token_balances: TokenBalances = Default::default();
            // Used to ensure at least one client action provides replay protection (WriteOnce).
            let mut has_replay_protection = false;
            for client_action in client_actions {
                client_action.assert_and_advance_phase(ref :curr_phase);
                let actions = match *client_action {
                    ClientAction::SetViewingKey(input) => self
                        .set_viewing_key(:user_addr, :user_private_key, :input),
                    ClientAction::OpenChannel(input) => self
                        .open_channel(
                            sender_addr: user_addr, sender_private_key: user_private_key, :input,
                        ),
                    ClientAction::OpenSubchannel(input) => self
                        .open_subchannel(sender_addr: user_addr, :input),
                    ClientAction::Deposit(input) => self
                        .deposit(:user_addr, :input, ref :token_balances),
                    ClientAction::CreateEncNote(input) => self
                        .create_enc_note(
                            sender_addr: user_addr,
                            sender_private_key: user_private_key,
                            :input,
                            ref :token_balances,
                        ),
                    ClientAction::CreateOpenNote(input) => self
                        .create_open_note(
                            sender_addr: user_addr, sender_private_key: user_private_key, :input,
                        ),
                    ClientAction::UseNote(input) => self
                        .use_note(
                            owner_addr: user_addr,
                            owner_private_key: user_private_key,
                            :input,
                            ref :token_balances,
                        ),
                    ClientAction::Withdraw(input) => self
                        .withdraw(:user_addr, :input, ref :token_balances),
                    ClientAction::InvokeExternal(input) => self.invoke_external(:input),
                };
                self._client_apply_actions(actions: actions.span(), ref :has_replay_protection);
                server_actions.extend(actions);
            }
            assert(has_replay_protection, errors::NO_REPLAY_PROTECTION);
            token_balances.squash().assert_valid();

            server_actions.span()
        }

        /// Returns the server actions to set a viewing key.
        /// Assumes `user_addr` is non-zero and `user_private_key` is non-zero and canonical
        /// (checked in `main`).
        fn set_viewing_key(
            self: @ContractState,
            user_addr: ContractAddress,
            user_private_key: felt252,
            input: SetViewingKeyInput,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let SetViewingKeyInput { random } = input;

            // Derive the public key from the private key.
            let user_public_key = derive_public_key(private_key: user_private_key);

            // Encrypt the private key for the auditor.
            let enc_private_key = encrypt_private_key(
                ephemeral_secret: random,
                auditor_public_key: self.auditor_public_key.read(),
                private_key: user_private_key,
            );

            array![
                to_write_once_action(
                    storage_address: storage_path_to_felt252(
                        path: self.public_key.entry(user_addr),
                    ),
                    value: user_public_key,
                ),
                to_write_once_action(
                    storage_address: storage_path_to_felt252(
                        path: self.enc_private_key.entry(user_addr),
                    ),
                    value: enc_private_key,
                ),
                ServerAction::EmitViewingKeySet(
                    events::ViewingKeySet {
                        user_addr, public_key: user_public_key, enc_private_key,
                    },
                ),
            ]
        }

        /// Returns the server actions to open a channel.
        /// Assumes `sender_addr` is non-zero and `sender_private_key` is non-zero and canonical
        /// (checked in `main`).
        fn open_channel(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            input: OpenChannelInput,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let OpenChannelInput { recipient_addr, index, random, salt } = input;

            // Assert sender is registered with the given private key.
            let sender_public_key = self.public_key.read(sender_addr);
            assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
            assert(
                sender_public_key == derive_public_key(private_key: sender_private_key),
                errors::SENDER_NOT_AUTHENTICATED,
            );

            // Assert recipient is registered.
            let recipient_public_key = self.public_key.read(recipient_addr);
            assert(recipient_public_key.is_non_zero(), errors::RECIPIENT_NOT_REGISTERED);

            // Assert index is sequential, i.e. the previous channel exists.
            assert(
                index.is_zero()
                    || self
                        .outgoing_channels
                        .entry(
                            compute_outgoing_channel_id(
                                :sender_addr, :sender_private_key, index: index - 1,
                            ),
                        )
                        .salt
                        .read()
                        .is_non_zero(),
                errors::INDEX_NOT_SEQUENTIAL,
            );

            // Compute the output values.
            let channel_key = compute_channel_key(
                :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key,
            );
            let enc_channel_info = encrypt_channel_info(
                ephemeral_secret: random, :recipient_public_key, :channel_key, :sender_addr,
            );
            let channel_marker = compute_channel_marker(
                :channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
            );
            let outgoing_channel_id = compute_outgoing_channel_id(
                :sender_addr, :sender_private_key, :index,
            );
            let enc_outgoing_channel_info = encrypt_outgoing_channel_info(
                :sender_addr, :sender_private_key, :index, :recipient_addr, :salt,
            );

            array![
                ServerAction::Append(AppendInput { recipient_addr, enc_channel_info }),
                to_write_once_action(
                    storage_address: storage_path_to_felt252(
                        path: self.channel_exists.entry(channel_marker),
                    ),
                    value: true,
                ),
                to_write_once_action(
                    storage_address: storage_path_to_felt252(
                        path: self.outgoing_channels.entry(outgoing_channel_id),
                    ),
                    value: enc_outgoing_channel_info,
                ),
            ]
        }

        /// Returns the server actions to open a subchannel.
        /// Assumes `sender_addr` is non-zero (checked in `main`).
        fn open_subchannel(
            self: @ContractState, sender_addr: ContractAddress, input: OpenSubchannelInput,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let OpenSubchannelInput {
                recipient_addr, recipient_public_key, channel_key, index, token, salt,
            } = input;

            // Assert channel key is valid for the given sender and recipient.
            let channel_marker = compute_channel_marker(
                :channel_key, :sender_addr, :recipient_addr, :recipient_public_key,
            );
            assert(self.channel_exists.read(channel_marker), errors::INVALID_CHANNEL);

            // Assert index is sequential, i.e. the previous subchannel exists.
            assert(
                index.is_zero()
                    || self
                        .subchannel_tokens
                        .entry(compute_subchannel_id(:channel_key, index: index - 1))
                        .salt
                        .read()
                        .is_non_zero(),
                errors::INDEX_NOT_SEQUENTIAL,
            );

            // Compute subchannel values.
            let subchannel_id = compute_subchannel_id(:channel_key, :index);
            let enc_subchannel_info = encrypt_subchannel_info(:channel_key, :index, :token, :salt);
            let subchannel_marker = compute_subchannel_marker(
                :channel_key, :recipient_addr, :recipient_public_key, :token,
            );

            array![
                to_write_once_action(
                    storage_address: storage_path_to_felt252(
                        path: self.subchannel_tokens.entry(subchannel_id),
                    ),
                    value: enc_subchannel_info,
                ),
                to_write_once_action(
                    storage_address: storage_path_to_felt252(
                        path: self.subchannel_exists.entry(subchannel_marker),
                    ),
                    value: true,
                ),
            ]
        }

        /// Returns the server actions to deposit funds into the contract.
        /// Assumes `user_addr` is non-zero (checked in `main`).
        fn deposit(
            self: @ContractState,
            user_addr: ContractAddress,
            input: DepositInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let DepositInput { token, amount } = input;

            token_balances.add_balance(:token, :amount);

            array![
                ServerAction::TransferFrom(
                    TransferFromInput { from_addr: user_addr, token, amount },
                ),
                ServerAction::EmitDeposit(events::Deposit { user_addr, token, amount }),
            ]
        }

        /// Returns the server actions to withdraw funds from the contract.
        /// Assumes `user_addr` is non-zero (checked in `main`).
        fn withdraw(
            self: @ContractState,
            user_addr: ContractAddress,
            input: WithdrawInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let WithdrawInput { to_addr, token, amount, random } = input;

            token_balances.subtract_balance(:token, :amount);

            // Encrypt the user address for the auditor.
            let enc_user_addr = encrypt_user_addr(
                ephemeral_secret: random,
                auditor_public_key: self.auditor_public_key.read(),
                :user_addr,
            );

            array![
                ServerAction::TransferTo(TransferToInput { to_addr, token, amount }),
                ServerAction::EmitWithdrawal(
                    events::Withdrawal { enc_user_addr, to_addr, token, amount },
                ),
            ]
        }

        /// Invokes an external contract by forwarding the contract address and calldata as a
        /// server-side Invoke action.
        fn invoke_external(
            self: @ContractState, input: InvokeExternalInput,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let InvokeExternalInput { contract_address, calldata } = input;
            array![ServerAction::Invoke(InvokeInput { contract_address, calldata })]
        }

        /// Returns the server actions to use a note.
        /// Assumes `owner_addr` is non-zero and `owner_private_key` is non-zero and canonical
        /// (checked in `main`).
        fn use_note(
            self: @ContractState,
            owner_addr: ContractAddress,
            owner_private_key: felt252,
            input: UseNoteInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let UseNoteInput { channel_key, token, index } = input;

            // Verify the owner owns the note's subchannel.
            let owner_public_key = derive_public_key(private_key: owner_private_key);
            let subchannel_marker = compute_subchannel_marker(
                :channel_key,
                recipient_addr: owner_addr,
                recipient_public_key: owner_public_key,
                :token,
            );
            assert(self.subchannel_exists.read(subchannel_marker), errors::SUBCHANNEL_NOT_FOUND);

            // Compute note_id from the verified components.
            let note_id = compute_note_id(:channel_key, :token, :index);

            // Read note from storage and assert it exists.
            let packed_value = self.notes.entry(note_id).packed_value.read();
            assert(packed_value.is_non_zero(), errors::NOTE_NOT_FOUND);

            // Decode note amount (handles both open and encrypted notes).
            let amount = decode_note_amount(:packed_value, :channel_key, :token, :index);
            assert(amount.is_non_zero(), errors::ZERO_NOTE_AMOUNT_USAGE);

            // Compute nullifier.
            let nullifier = compute_nullifier(:channel_key, :token, :index, :owner_private_key);

            token_balances.add_balance(:token, :amount);

            array![
                to_write_once_action(
                    storage_address: storage_path_to_felt252(
                        path: self.nullifiers.entry(nullifier),
                    ),
                    value: true,
                ),
                ServerAction::EmitNoteUsed(events::NoteUsed { nullifier }),
            ]
        }

        /// Returns the server actions to create an encrypted note.
        /// Assumes `sender_addr` is non-zero and `sender_private_key` is non-zero and canonical
        /// (checked in `main`).
        fn create_enc_note(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            input: CreateEncNoteInput,
            ref token_balances: TokenBalances,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let CreateEncNoteInput {
                recipient_addr, recipient_public_key, token, amount, index, salt,
            } = input;

            // Validate and compute note values.
            let (channel_key, storage_address, note_id) = self
                ._prepare_note_creation(
                    :sender_addr,
                    :sender_private_key,
                    :recipient_addr,
                    :recipient_public_key,
                    :token,
                    :index,
                );

            // `packed_value` contains `(salt, enc_amount)`.
            let packed_value = enc_note_packed_value(:channel_key, :token, :index, :salt, :amount);
            assert(packed_value.is_non_zero(), internal_errors::ZERO_NOTE_VALUE);

            token_balances.subtract_balance(:token, :amount);

            // Only `packed_value` needs to be written to storage, `token` and `depositor` are
            // initialized to zero.
            array![
                to_write_once_action(:storage_address, value: packed_value),
                ServerAction::EmitEncNoteCreated(events::EncNoteCreated { note_id, packed_value }),
            ]
        }

        /// Returns the server action to create an open note.
        /// Assumes `sender_addr` is non-zero and `sender_private_key` is non-zero and canonical
        /// (checked in `main`).
        fn create_open_note(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            input: CreateOpenNoteInput,
        ) -> Array<ServerAction> {
            input.assert_valid();
            let CreateOpenNoteInput {
                recipient_addr, recipient_public_key, token, index, depositor, random,
            } = input;

            // Validate and compute note values.
            let (_, storage_address, note_id) = self
                ._prepare_note_creation(
                    :sender_addr,
                    :sender_private_key,
                    :recipient_addr,
                    :recipient_public_key,
                    :token,
                    :index,
                );

            let note = open_note(:token, :depositor);
            assert(note.packed_value.is_non_zero(), internal_errors::ZERO_NOTE_VALUE);

            // Encrypt the recipient address for the auditor.
            let enc_recipient_addr = encrypt_user_addr(
                ephemeral_secret: random,
                auditor_public_key: self.auditor_public_key.read(),
                user_addr: recipient_addr,
            );

            array![
                to_write_once_action(:storage_address, value: note),
                ServerAction::EmitOpenNoteCreated(
                    events::OpenNoteCreated { enc_recipient_addr, depositor, token, note_id },
                ),
            ]
        }

        /// Validates preconditions and computes values needed for creating a note.
        /// Returns `(channel_key, storage_address, note_id)`.
        /// Assumes all input is valid (non-zero, canonical private_key).
        fn _prepare_note_creation(
            self: @ContractState,
            sender_addr: ContractAddress,
            sender_private_key: felt252,
            recipient_addr: ContractAddress,
            recipient_public_key: felt252,
            token: ContractAddress,
            index: usize,
        ) -> (felt252, felt252, felt252) {
            let channel_key = compute_channel_key(
                :sender_addr, :sender_private_key, :recipient_addr, :recipient_public_key,
            );

            // Assert subchannel exists.
            let subchannel_marker = compute_subchannel_marker(
                :channel_key, :recipient_addr, :recipient_public_key, :token,
            );
            assert(self.subchannel_exists.read(subchannel_marker), errors::SUBCHANNEL_NOT_FOUND);

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

            // Compute note id and assert it is non-zero.
            let note_id = compute_note_id(:channel_key, :token, :index);

            let storage_address = storage_path_to_felt252(path: self.notes.entry(note_id));
            (channel_key, storage_address, note_id)
        }

        fn _client_apply_actions(
            ref self: ContractState, actions: Span<ServerAction>, ref has_replay_protection: bool,
        ) {
            for action in actions {
                match *action {
                    ServerAction::WriteOnce(input) => {
                        self._apply_write_once(:input);
                        has_replay_protection = true;
                    },
                    ServerAction::Append(input) => self._apply_append(:input),
                    ServerAction::TransferFrom(_) => {},
                    ServerAction::TransferTo(_) => {},
                    ServerAction::Invoke(_) => {},
                    ServerAction::EmitViewingKeySet(_) => {},
                    ServerAction::EmitWithdrawal(_) => {},
                    ServerAction::EmitDeposit(_) => {},
                    ServerAction::EmitOpenNoteCreated(_) => {},
                    ServerAction::EmitEncNoteCreated(_) => {},
                    ServerAction::EmitNoteUsed(_) => {},
                }
            }
        }
    }

    #[abi(embed_v0)]
    pub impl ServerImpl of IServer<ContractState> {
        fn apply_actions(ref self: ContractState, actions: Span<ServerAction>) {
            self.reentrancyguard.start();
            self.pausable.assert_not_paused();
            self.validate_proof(:actions);
            self.collect_fee();
            self._apply_actions(:actions);
            self.reentrancyguard.end();
        }
    }

    #[generate_trait]
    pub impl ServerInternalImpl of ServerInternalTrait {
        fn validate_proof(self: @ContractState, actions: Span<ServerAction>) {
            let execution_info = get_execution_info_v3_syscall().unwrap_syscall();
            let contract_address = execution_info.contract_address;
            let mut proof_facts_span = execution_info.tx_info.proof_facts;
            assert(!proof_facts_span.is_empty(), errors::EMPTY_PROOF_FACTS);
            let proof_facts: ProofFacts = Serde::deserialize(ref proof_facts_span)
                .expect(errors::PROOF_FACTS_DESERIALIZE_ERROR);
            assert(proof_facts_span.is_empty(), errors::INVALID_PROOF_FACTS);
            let ProofFacts {
                proof_version: _,
                program_variant,
                virtual_program_hash: _,
                starknet_os_output_version,
                base_block_number,
                base_block_hash: _,
                starknet_os_config_hash: _,
                message_to_l1_hashes,
            } = proof_facts;

            // Assert program variant and output version are correct.
            assert(program_variant == VIRTUAL_SNOS, errors::INVALID_PROGRAM_VARIANT);
            assert(starknet_os_output_version == VIRTUAL_SNOS0, errors::INVALID_OS_OUTPUT_VERSION);

            // Assert base block number is recent.
            let current_block_number = execution_info.block_info.block_number;
            assert(base_block_number < current_block_number, errors::INVALID_BASE_BLOCK_NUMBER);
            assert(
                current_block_number <= base_block_number + self.proof_validity_blocks.read(),
                errors::PROOF_EXPIRED,
            );

            // Assert that the message hash is included in the L1 messages,
            // meaning the proof is valid for this transaction.
            let message_hash = compute_message_hash(:actions, :contract_address);
            assert(message_to_l1_hashes == [message_hash].span(), errors::INVALID_PROOF_MSG);
        }

        fn collect_fee(ref self: ContractState) {
            let fee_amount = self.fee_amount.read();
            if fee_amount.is_non_zero() {
                let fee_collector = self.fee_collector.read();
                checked_transfer_from(
                    token_address: STRK_TOKEN_ADDRESS,
                    sender: get_caller_address(),
                    recipient: fee_collector,
                    amount: fee_amount.into(),
                );
            }
        }

        fn _apply_actions(ref self: ContractState, actions: Span<ServerAction>) {
            let mut open_notes_created: usize = Zero::zero();
            let mut open_notes_filled = Zero::zero();
            for action in actions {
                match *action {
                    ServerAction::WriteOnce(input) => self._apply_write_once(:input),
                    ServerAction::Append(input) => self._apply_append(:input),
                    ServerAction::TransferFrom(input) => self._apply_transfer_from(:input),
                    ServerAction::TransferTo(input) => self._apply_transfer_to(:input),
                    ServerAction::Invoke(input) => {
                        let open_note_deposits = self._apply_invoke(:input);
                        // Apply deposits to open notes returned by Invoke.
                        for deposit in open_note_deposits {
                            self
                                ._deposit_to_open_note(
                                    depositor: input.contract_address, deposit: *deposit,
                                );
                        }
                    },
                    ServerAction::EmitViewingKeySet(event) => self.emit(event),
                    ServerAction::EmitWithdrawal(event) => self.emit(event),
                    ServerAction::EmitDeposit(event) => self.emit(event),
                    ServerAction::EmitOpenNoteCreated(event) => {
                        self.emit(event);
                        open_notes_created += 1;
                    },
                    ServerAction::EmitEncNoteCreated(event) => self.emit(event),
                    ServerAction::EmitNoteUsed(event) => self.emit(event),
                };
            }
            assert(open_notes_filled == open_notes_created, errors::UNFILLED_OPEN_NOTES);
        }

        fn _apply_write_once(ref self: ContractState, input: WriteOnceInput) {
            let WriteOnceInput { storage_address, value } = input;
            assert(!value.is_empty(), internal_errors::UNEXPECTED_EMPTY_VALUE);
            assert(value[0].is_non_zero(), internal_errors::UNEXPECTED_ZERO_VALUE);
            let base: StorageBaseAddress = storage_base_address_from_felt252(addr: storage_address);
            let mut offset = 0;
            for felt in value {
                let address = storage_address_from_base_and_offset(:base, :offset);
                assert(
                    storage_read_syscall(address_domain: 0, :address).unwrap_syscall().is_zero(),
                    errors::NON_ZERO_VALUE,
                );
                storage_write_syscall(address_domain: 0, :address, value: *felt).unwrap_syscall();
                offset += 1;
            }
        }

        fn _apply_append(ref self: ContractState, input: AppendInput) {
            let AppendInput { recipient_addr, enc_channel_info } = input;
            self.recipient_channels.entry(recipient_addr).push(enc_channel_info);
        }

        fn _apply_transfer_from(ref self: ContractState, input: TransferFromInput) {
            let TransferFromInput { from_addr, token, amount } = input;
            checked_transfer_from(
                token_address: token,
                sender: from_addr,
                recipient: get_contract_address(),
                amount: amount.into(),
            );
        }

        fn _apply_transfer_to(ref self: ContractState, input: TransferToInput) {
            let TransferToInput { to_addr, token, amount } = input;
            // Note: This function should NOT panic as the contract should have the balance.
            checked_transfer(token_address: token, recipient: to_addr, amount: amount.into());
        }

        fn _apply_invoke(ref self: ContractState, input: InvokeInput) -> Span<OpenNoteDeposit> {
            let InvokeInput { contract_address, calldata } = input;
            let mut return_data = call_contract_syscall(
                address: contract_address, entry_point_selector: INVOKE_SELECTOR, :calldata,
            )
                .unwrap_syscall();

            let deposits: Span<OpenNoteDeposit> = Serde::deserialize(ref return_data)
                .expect(errors::INVALID_INVOKE_RETURN_DATA);
            assert(return_data.is_empty(), errors::INVALID_INVOKE_RETURN_DATA);
            deposits
        }

        /// Applies a single deposit to an open note. Verifies the input depositor matches the
        /// note's depositor. Used when applying the span returned by an Invoke.
        fn _deposit_to_open_note(
            ref self: ContractState, depositor: ContractAddress, deposit: OpenNoteDeposit,
        ) {
            let OpenNoteDeposit { note_id, token, amount } = deposit;
            assert(token.is_non_zero(), errors::ZERO_TOKEN);
            assert(amount.is_non_zero(), errors::ZERO_AMOUNT);

            // Read the Note from storage and assert it exists.
            let note_entry = self.notes.entry(note_id);
            let Note {
                packed_value, token: note_token, depositor: note_depositor,
            } = note_entry.read();
            assert(packed_value.is_non_zero(), errors::NOTE_NOT_FOUND);

            let (salt, current_amount) = unpack(:packed_value);
            assert(salt == OPEN_NOTE_SALT, errors::NOTE_NOT_OPEN);
            assert(current_amount.is_zero(), errors::NOTE_ALREADY_DEPOSITED);
            assert(token == note_token, errors::TOKEN_MISMATCH);
            assert(depositor == note_depositor, errors::DEPOSITOR_MISMATCH);

            checked_transfer_from(
                token_address: token,
                sender: depositor,
                recipient: get_contract_address(),
                amount: amount.into(),
            );

            // Write the new `packed_value` (OPEN_NOTE_SALT, amount) to storage.
            let new_packed_value = pack(value_1: OPEN_NOTE_SALT, value_2: amount);
            assert(new_packed_value.is_non_zero(), internal_errors::ZERO_NOTE_VALUE);
            note_entry.packed_value.write(new_packed_value);

            self.emit(events::OpenNoteDeposited { depositor, token, note_id, amount });
        }
    }

    #[abi(embed_v0)]
    pub impl ViewsImpl of IViews<ContractState> {
        fn channel_exists(self: @ContractState, channel_marker: felt252) -> bool {
            self.channel_exists.read(channel_marker)
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
            self: @ContractState, outgoing_channel_id: felt252,
        ) -> EncOutgoingChannelInfo {
            self.outgoing_channels.read(outgoing_channel_id)
        }

        fn subchannel_exists(self: @ContractState, subchannel_marker: felt252) -> bool {
            self.subchannel_exists.read(subchannel_marker)
        }

        fn get_subchannel_info(self: @ContractState, subchannel_id: felt252) -> EncSubchannelInfo {
            self.subchannel_tokens.read(subchannel_id)
        }

        fn get_note(self: @ContractState, note_id: felt252) -> Note {
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

        fn get_auditor_public_key(self: @ContractState) -> felt252 {
            self.auditor_public_key.read()
        }

        fn get_fee_amount(self: @ContractState) -> u128 {
            self.fee_amount.read()
        }

        fn get_fee_collector(self: @ContractState) -> ContractAddress {
            self.fee_collector.read()
        }

        fn get_proof_validity_blocks(self: @ContractState) -> u64 {
            self.proof_validity_blocks.read()
        }
    }

    #[abi(embed_v0)]
    pub impl AdminImpl of IAdmin<ContractState> {
        fn set_auditor_public_key(ref self: ContractState, auditor_public_key: felt252) {
            // TODO: Change to the real role.
            self.roles.only_token_admin();
            self._set_auditor_public_key(:auditor_public_key);
        }

        fn set_fee_amount(ref self: ContractState, fee_amount: u128) {
            // TODO: Change to real role.
            self.roles.only_app_governor();
            if fee_amount.is_non_zero() {
                assert(self.fee_collector.read().is_non_zero(), errors::ZERO_FEE_COLLECTOR);
            }
            self.fee_amount.write(fee_amount);
            self.emit(events::FeeAmountSet { fee_amount });
        }

        fn set_fee_collector(ref self: ContractState, fee_collector: ContractAddress) {
            // TODO: Change to real role.
            self.roles.only_app_governor();
            if self.fee_amount.read().is_non_zero() {
                assert(fee_collector.is_non_zero(), errors::ZERO_FEE_COLLECTOR);
            }
            self.fee_collector.write(fee_collector);
            self.emit(events::FeeCollectorSet { fee_collector });
        }

        fn set_proof_validity_blocks(ref self: ContractState, proof_validity_blocks: u64) {
            // TODO: Change to real role.
            self.roles.only_app_governor();
            self._set_proof_validity_blocks(:proof_validity_blocks);
        }
    }

    #[generate_trait]
    impl AdminInternalImpl of AdminInternalTrait {
        fn _set_auditor_public_key(ref self: ContractState, auditor_public_key: felt252) {
            assert(auditor_public_key.is_non_zero(), errors::ZERO_AUDITOR_PUBLIC_KEY);
            self.auditor_public_key.write(auditor_public_key);
            self.emit(events::AuditorPublicKeySet { auditor_public_key });
        }

        fn _set_proof_validity_blocks(ref self: ContractState, proof_validity_blocks: u64) {
            assert(proof_validity_blocks.is_non_zero(), errors::ZERO_PROOF_VALIDITY_BLOCKS);
            self.proof_validity_blocks.write(proof_validity_blocks);
            self.emit(events::ProofValidityBlocksSet { proof_validity_blocks });
        }
    }
}
