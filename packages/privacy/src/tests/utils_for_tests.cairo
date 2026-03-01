use core::ec::EcPointTrait;
use core::num::traits::Zero;
use core::traits::Neg;
use privacy::actions::{
    AppendInput, ClientAction, CreateEncNoteInput, CreateOpenNoteInput, DepositInput,
    InvokeExternalInput, InvokeInput, OpenChannelInput, OpenSubchannelInput, ServerAction,
    SetViewingKeyInput, TransferFromInput, TransferToInput, UseNoteInput, WithdrawInput,
};
use privacy::events;
use privacy::hashes::{
    compute_channel_key, compute_channel_marker, compute_enc_channel_key_hash,
    compute_enc_private_key_hash, compute_enc_recipient_addr_hash, compute_enc_sender_addr_hash,
    compute_enc_token_hash, compute_enc_user_addr_hash, compute_note_id, compute_nullifier,
    compute_outgoing_channel_id, compute_subchannel_id, compute_subchannel_marker, hash,
};
use privacy::interface::{
    IAdminDispatcher, IAdminDispatcherTrait, IAdminSafeDispatcher, IAdminSafeDispatcherTrait,
    IClientDispatcher, IClientDispatcherTrait, IClientSafeDispatcher, IClientSafeDispatcherTrait,
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
    IViewsDispatcher, IViewsDispatcherTrait, IViewsSafeDispatcher, IViewsSafeDispatcherTrait,
};
use privacy::objects::{
    EncChannelInfo, EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo, EncUserAddr, Note,
    TokenBalances, TokenBalancesTrait,
};
use privacy::privacy::Privacy;
use privacy::privacy::Privacy::{ClientInternalTrait, deploy_for_test as deploy_privacy_for_test};
use privacy::tests::mock_account::MockAccount::deploy_for_test as deploy_mock_account_for_test;
use privacy::tests::mock_amm::MockAMM::deploy_for_test as deploy_mock_amm_for_test;
use privacy::tests::mock_reentrancy::MockReentrancy::deploy_for_test as deploy_mock_reentrancy_for_test;
use privacy::tests::mock_swap_executor::MockSwapExecutor::deploy_for_test as deploy_mock_swap_executor_for_test;
use privacy::tests::mock_swap_executor::{
    ISwapExecutorDispatcher, ISwapExecutorDispatcherTrait, ISwapExecutorSafeDispatcher,
    ISwapExecutorSafeDispatcherTrait,
};
use privacy::tests::utils_for_tests::constants::DEFAULT_PROOF_VALIDITY_BLOCKS;
use privacy::utils::constants::{ENTRYPOINT_FAILED, OK_WRAPPER, OPEN_NOTE_SALT, TWO_POW_120};
use privacy::utils::{
    ProofFacts, compute_message_hash, derive_public_key, enc_note_packed_value,
    encrypt_outgoing_channel_info, encrypt_private_key, encrypt_subchannel_info, encrypt_user_addr,
    is_canonical_key, pack, to_write_once_action,
};
use snforge_std::{
    CheatSpan, CustomToken, DeclareResultTrait, MessageToL1, MessageToL1Spy, MessageToL1SpyTrait,
    Token, TokenTrait, cheat_proof_facts, cheat_resource_bounds, declare, interact_with_state,
    map_entry_address, spy_messages_to_l1, store,
};
use starknet::account::Call;
use starknet::deployment::DeploymentParams;
use starknet::storage::StorableStoragePointerReadAccess;
use starknet::{ContractAddress, ResourcesBounds, SyscallResultTrait};
use starkware_utils::components::pausable::interface::{
    IPausableDispatcher, IPausableDispatcherTrait,
};
use starkware_utils_testing::test_utils::{
    Deployable, TokenConfig, TokenHelperTrait, cheat_caller_address_once, generic_load,
    set_account_as_app_governor, set_account_as_app_role_admin, set_account_as_security_agent,
    set_account_as_token_admin,
};

pub impl NoteZero of Zero<Note> {
    fn zero() -> Note {
        Note { packed_value: Zero::zero(), token: Zero::zero(), depositor: Zero::zero() }
    }

    fn is_zero(self: @Note) -> bool {
        (*self.packed_value).is_zero() && (*self.token).is_zero() && (*self.depositor).is_zero()
    }

    fn is_non_zero(self: @Note) -> bool {
        !self.is_zero()
    }
}

#[generate_trait]
pub(crate) impl InvokeExternalInputIntoServerActionImpl of InvokeExternalInputIntoServerActionTrait {
    fn into_server_action(self: @InvokeExternalInput) -> ServerAction {
        let InvokeExternalInput { contract_address, calldata } = *self;
        ServerAction::Invoke(InvokeInput { contract_address, calldata })
    }

    fn into_server_actions(self: @InvokeExternalInput) -> Span<ServerAction> {
        [self.into_server_action()].span()
    }
}

#[generate_trait]
pub(crate) impl CreateEncNoteInputIntoServerActionImpl of CreateEncNoteInputIntoServerActionTrait {
    fn into_server_action(self: @CreateEncNoteInput, user: User) -> ServerAction {
        let (note_id, note) = user.compute_enc_note(create_note_input: *self);
        let storage_path = map_entry_address(
            map_selector: selector!("notes"), keys: [note_id].span(),
        );
        to_write_once_action(storage_address: storage_path, value: note.packed_value)
    }

    fn into_server_actions(self: @CreateEncNoteInput, user: User) -> Span<ServerAction> {
        [self.into_server_action(:user)].span()
    }
}

#[generate_trait]
pub(crate) impl CreateOpenNoteInputIntoServerActionImpl of CreateOpenNoteInputIntoServerActionTrait {
    fn into_server_actions(self: @CreateOpenNoteInput, user: User) -> Span<ServerAction> {
        let (note_id, note) = user.compute_open_note(create_note_input: *self);
        let storage_path = map_entry_address(
            map_selector: selector!("notes"), keys: [note_id].span(),
        );
        let enc_recipient_addr = encrypt_user_addr(
            ephemeral_secret: *self.random,
            auditor_public_key: user.privacy.get_auditor_public_key(),
            user_addr: *self.recipient_addr,
        );

        [
            to_write_once_action(storage_address: storage_path, value: note),
            ServerAction::EmitOpenNoteCreated(
                events::OpenNoteCreated {
                    enc_recipient_addr, depositor: note.depositor, token: note.token, note_id,
                },
            ),
        ]
            .span()
    }
}

pub(crate) mod constants {
    use core::num::traits::Pow;
    use starknet::ContractAddress;

    pub const DECIMALS: u8 = 18;
    pub const TOKEN_SUPPLY: u256 = 10_u256.pow(12 + DECIMALS.into());
    pub const TOKEN_OWNER: ContractAddress = 'TOKEN_OWNER'.try_into().unwrap();
    pub const DEFAULT_AMOUNT: u128 = 10_u128.pow(DECIMALS.into());
    pub const DEFAULT_FEE_AMOUNT: u128 = 1000;
    pub const DEFAULT_FEE_COLLECTOR: ContractAddress = 'FEE_COLLECTOR'.try_into().unwrap();
    pub const PAYMASTER: ContractAddress = 'PAYMASTER'.try_into().unwrap();
    pub const DEFAULT_PROOF_VALIDITY_BLOCKS: u64 = 450; // ~15 min (2 sec/block)
}


#[derive(Copy, Drop)]
pub(crate) struct Roles {
    pub governance_admin: ContractAddress,
    pub security_agent: ContractAddress,
    pub app_role_admin: ContractAddress,
    pub token_admin: ContractAddress,
    pub app_governor: ContractAddress,
}

impl DefaultRolesImpl of Default<Roles> {
    fn default() -> Roles {
        Roles {
            governance_admin: 'GOVERNANCE_ADMIN'.try_into().unwrap(),
            security_agent: 'SECURITY_AGENT'.try_into().unwrap(),
            app_role_admin: 'APP_ROLE_ADMIN'.try_into().unwrap(),
            token_admin: 'TOKEN_ADMIN'.try_into().unwrap(),
            app_governor: 'APP_GOVERNOR'.try_into().unwrap(),
        }
    }
}

#[derive(Copy, Drop)]
pub(crate) struct SwapExecutorCfg {
    pub address: ContractAddress,
    pub privacy_address: ContractAddress,
}


#[derive(Copy, Drop)]
pub(crate) struct PrivacyCfg {
    pub address: ContractAddress,
    pub roles: Roles,
    server: IServerDispatcher,
    safe_server: IServerSafeDispatcher,
    client: IClientDispatcher,
    safe_client: IClientSafeDispatcher,
    views: IViewsDispatcher,
    safe_views: IViewsSafeDispatcher,
    admin: IAdminDispatcher,
    safe_admin: IAdminSafeDispatcher,
    pub strk_token: Token,
    pub swap_executor: SwapExecutorCfg,
    pub mock_amm: ContractAddress,
}

#[derive(Copy, Drop)]
struct User {
    pub address: ContractAddress,
    pub privacy: PrivacyCfg,
    pub private_key: felt252,
    pub public_key: felt252,
    nonce: usize,
}

#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn execute(self: @User, client_actions: Span<ClientAction>) -> Span<ServerAction> {
        self
            .privacy
            .execute(user_addr: *self.address, user_private_key: *self.private_key, :client_actions)
    }

    fn safe_execute(self: @User, client_actions: Span<ClientAction>) -> Result<(), Array<felt252>> {
        self
            .privacy
            .safe_execute(
                user_addr: *self.address, user_private_key: *self.private_key, :client_actions,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_execute_and_panic(
        self: @User, client_actions: Span<ClientAction>,
    ) -> Result<(), Array<felt252>> {
        self
            .privacy
            .safe_execute_and_panic(
                user_addr: *self.address, user_private_key: *self.private_key, :client_actions,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_execute_view(
        self: @User, client_actions: Span<ClientAction>,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .privacy
            .safe_execute_view(
                user_addr: *self.address, user_private_key: *self.private_key, :client_actions,
            )
    }

    fn safe_validate(
        self: @User, client_actions: Span<ClientAction>,
    ) -> Result<felt252, Array<felt252>> {
        self
            .privacy
            .safe_validate(
                user_addr: *self.address, user_private_key: *self.private_key, :client_actions,
            )
    }

    fn execute_view(self: @User, client_actions: Span<ClientAction>) -> Span<ServerAction> {
        self
            .privacy
            .execute_view(
                user_addr: *self.address, user_private_key: *self.private_key, :client_actions,
            )
    }

    fn execute_and_panic(self: @User, client_actions: Span<ClientAction>) -> Span<ServerAction> {
        let result = self
            .privacy
            .safe_execute_and_panic(
                user_addr: *self.address, user_private_key: *self.private_key, :client_actions,
            );
        assert!(result.is_err());
        let mut panic_data = result.unwrap_err();
        let len = panic_data.len();
        assert_eq!(*panic_data[len - 1], ENTRYPOINT_FAILED);
        assert_eq!(*panic_data[len - 2], OK_WRAPPER);
        assert_eq!(*panic_data[0], OK_WRAPPER);
        let _ = panic_data.pop_front();
        let mut serialized_server_actions = panic_data.span();
        let server_actions: Span<ServerAction> = Serde::deserialize(ref serialized_server_actions)
            .expect('DESERIALIZE_FAILED');
        server_actions
    }

    fn transfer(
        self: @User, notes_to_use: Span<UseNoteInput>, notes_to_create: Span<CreateEncNoteInput>,
    ) -> Span<ServerAction> {
        let mut client_actions: Array<ClientAction> = array![];
        for note in notes_to_use {
            client_actions.append(ClientAction::UseNote(*note));
        }
        for note in notes_to_create {
            client_actions.append(ClientAction::CreateEncNote(*note));
        }
        self.execute(client_actions: client_actions.span())
    }

    fn safe_transfer(
        self: @User, notes_to_use: Span<UseNoteInput>, notes_to_create: Span<CreateEncNoteInput>,
    ) -> Result<(), Array<felt252>> {
        let mut client_actions: Array<ClientAction> = array![];
        for note in notes_to_use {
            client_actions.append(ClientAction::UseNote(*note));
        }
        for note in notes_to_create {
            client_actions.append(ClientAction::CreateEncNote(*note));
        }
        self.safe_execute(client_actions: client_actions.span())
    }

    fn withdraw_and_use_note_e2e(
        ref self: User,
        to_addr: ContractAddress,
        token: Token,
        amount: u128,
        channel_key: felt252,
        index: usize,
    ) {
        let random = self.get_random();
        let use_note_input = UseNoteInput { channel_key, token: token.contract_address(), index };
        let withdraw_input = WithdrawInput {
            to_addr, token: token.contract_address(), amount, random,
        };
        let server_actions = self
            .execute(
                client_actions: [
                    ClientAction::UseNote(use_note_input), ClientAction::Withdraw(withdraw_input),
                ]
                    .span(),
            );
        self.privacy.apply_actions(actions: server_actions);
    }

    fn internal_withdraw(
        self: @User,
        to_addr: ContractAddress,
        token_addr: ContractAddress,
        amount: u128,
        random: felt252,
    ) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let mut token_balances: TokenBalances = Default::default();
                token_balances.add_balance(token: token_addr, :amount);
                let input = WithdrawInput { to_addr, token: token_addr, amount, random };
                state.withdraw(user_addr: *self.address, :input, ref :token_balances)
            },
        )
            .span()
    }

    /// Returns (random, output) where output is the output of `withdraw`.
    fn internal_withdraw_with_generated_random(
        ref self: User, to_addr: ContractAddress, token_addr: ContractAddress, amount: u128,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random();
        let output = self.internal_withdraw(:to_addr, :token_addr, :amount, :random);
        (random, output)
    }

    fn internal_invoke_external(self: @User, input: InvokeExternalInput) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                state.invoke_external(:input)
            },
        )
            .span()
    }

    fn safe_withdraw(
        self: @User,
        to_addr: ContractAddress,
        token_addr: ContractAddress,
        amount: u128,
        random: felt252,
    ) -> Result<(), Array<felt252>> {
        let input = WithdrawInput { to_addr, token: token_addr, amount, random };
        self.safe_execute(client_actions: [ClientAction::Withdraw(input)].span())
    }

    fn open_channel(
        self: @User, recipient: User, index: usize, random: felt252, salt: felt252,
    ) -> Span<ServerAction> {
        let input = OpenChannelInput { recipient_addr: recipient.address, index, random, salt };
        self.execute(client_actions: [ClientAction::OpenChannel(input)].span())
    }

    fn internal_open_channel(
        self: @User, recipient: User, index: usize, random: felt252, salt: felt252,
    ) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let input = OpenChannelInput {
                    recipient_addr: recipient.address, index, random, salt,
                };
                state
                    .open_channel(
                        sender_addr: *self.address, sender_private_key: *self.private_key, :input,
                    )
            },
        )
            .span()
    }

    fn safe_open_channel(
        self: @User, recipient: User, index: usize, random: felt252, salt: felt252,
    ) -> Result<(), Array<felt252>> {
        let input = OpenChannelInput { recipient_addr: recipient.address, index, random, salt };
        self.safe_execute(client_actions: [ClientAction::OpenChannel(input)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel_execute_and_panic(
        self: @User, recipient: User, index: usize, random: felt252, salt: felt252,
    ) -> Result<(), Array<felt252>> {
        let input = OpenChannelInput { recipient_addr: recipient.address, index, random, salt };
        self.safe_execute_and_panic(client_actions: [ClientAction::OpenChannel(input)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel_execute_view(
        self: @User, recipient: User, index: usize, random: felt252, salt: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        let input = OpenChannelInput { recipient_addr: recipient.address, index, random, salt };
        self.safe_execute_view(client_actions: [ClientAction::OpenChannel(input)].span())
    }

    /// Returns (random, salt, output) where output is the output of `open_channel`.
    fn internal_open_channel_with_generated_random_and_salt(
        ref self: User, recipient: User, index: usize,
    ) -> (felt252, felt252, Span<ServerAction>) {
        let random = self.get_random();
        let salt = self.get_salt().into();
        let output = self.internal_open_channel(:recipient, :index, :random, :salt);
        (random, salt, output)
    }

    /// Returns the (random, salt) generated by the user for the channel opening.
    fn open_channel_e2e(ref self: User, recipient: User, index: usize) -> (felt252, felt252) {
        let random = self.get_random();
        let salt = self.get_salt().into();
        let actions = self.open_channel(:recipient, :index, :random, :salt);
        self.privacy.apply_actions(:actions);
        (random, salt)
    }

    fn open_subchannel(
        self: @User, recipient: User, token_addr: ContractAddress, index: usize, salt: felt252,
    ) -> Span<ServerAction> {
        let channel_key = self.compute_channel_key(:recipient);
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_addr,
            salt,
        };
        self.execute(client_actions: [ClientAction::OpenSubchannel(input),].span())
    }

    fn internal_open_subchannel(
        self: @User, recipient: User, token_addr: ContractAddress, index: usize, salt: felt252,
    ) -> Span<ServerAction> {
        let channel_key = self.compute_channel_key(:recipient);
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let input = OpenSubchannelInput {
                    recipient_addr: recipient.address,
                    recipient_public_key: recipient.public_key,
                    channel_key,
                    index,
                    token: token_addr,
                    salt,
                };
                state.open_subchannel(sender_addr: *self.address, :input)
            },
        )
            .span()
    }

    fn safe_open_subchannel(
        self: @User, recipient: User, token_addr: ContractAddress, index: usize, salt: felt252,
    ) -> Result<(), Array<felt252>> {
        let channel_key = self.compute_channel_key(:recipient);
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_addr,
            salt,
        };
        self.safe_execute(client_actions: [ClientAction::OpenSubchannel(input),].span())
    }

    fn safe_open_subchannel_execute_and_panic(
        self: @User, recipient: User, token_addr: ContractAddress, index: usize, salt: felt252,
    ) -> Result<(), Array<felt252>> {
        let channel_key = self.compute_channel_key(:recipient);
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_addr,
            salt,
        };
        self.safe_execute_and_panic(client_actions: [ClientAction::OpenSubchannel(input),].span())
    }

    fn safe_open_subchannel_execute_view(
        self: @User, recipient: User, token_addr: ContractAddress, index: usize, salt: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        let channel_key = self.compute_channel_key(:recipient);
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_addr,
            salt,
        };
        self.safe_execute_view(client_actions: [ClientAction::OpenSubchannel(input),].span())
    }

    fn safe_open_subchannel_with_channel_key(
        self: @User,
        recipient: User,
        token_addr: ContractAddress,
        index: usize,
        salt: felt252,
        channel_key: felt252,
    ) -> Result<(), Array<felt252>> {
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_addr,
            salt,
        };
        self.safe_execute(client_actions: [ClientAction::OpenSubchannel(input),].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_open_subchannel_with_channel_key_execute_and_panic(
        self: @User,
        recipient: User,
        token_addr: ContractAddress,
        index: usize,
        salt: felt252,
        channel_key: felt252,
    ) -> Result<(), Array<felt252>> {
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_addr,
            salt,
        };
        self.safe_execute_and_panic(client_actions: [ClientAction::OpenSubchannel(input),].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_open_subchannel_with_channel_key_execute_view(
        self: @User,
        recipient: User,
        token_addr: ContractAddress,
        index: usize,
        salt: felt252,
        channel_key: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_addr,
            salt,
        };
        self.safe_execute_view(client_actions: [ClientAction::OpenSubchannel(input),].span())
    }

    /// Returns (salt, output) where output is the output of `open_subchannel`.
    fn internal_open_subchannel_with_generated_salt(
        ref self: User, recipient: User, token_addr: ContractAddress, index: usize,
    ) -> (felt252, Span<ServerAction>) {
        let salt = self.get_salt().into();
        let output = self.internal_open_subchannel(:recipient, :token_addr, :index, :salt);
        (salt, output)
    }

    /// Returns the salt generated by the user for the subchannel opening.
    fn open_subchannel_e2e(
        ref self: User, recipient: User, token_addr: ContractAddress, index: usize,
    ) -> felt252 {
        let salt = self.get_salt().into();
        let actions = self.open_subchannel(:recipient, :token_addr, :index, :salt);
        self.privacy.apply_actions(:actions);
        salt
    }

    /// Open a channel and a subchannel with the given token.
    /// Returns (random_generated_for_channel, salt_generated_for_subchannel).
    fn open_channel_with_token_e2e(
        ref self: User, recipient: User, token_addr: ContractAddress, outgoing_channel_index: usize,
    ) -> (felt252, felt252, felt252) {
        let (random_channel, salt_channel) = self
            .open_channel_e2e(:recipient, index: outgoing_channel_index);
        let salt_subchannel = self.open_subchannel_e2e(:recipient, :token_addr, index: 0);
        (random_channel, salt_channel, salt_subchannel)
    }

    /// Returns a random value.
    fn get_random(ref self: User) -> felt252 {
        let nonce = self.get_nonce();
        hash(['RANDOM', nonce.into()].span())
    }

    fn get_nonce(ref self: User) -> u32 {
        self.nonce += 1;
        self.nonce
    }

    /// Returns a random 120-bit salt.
    fn get_salt(ref self: User) -> u128 {
        let nonce = self.get_nonce();
        let salt_u256: u256 = hash(['SALT', nonce.into()].span()).into();
        (salt_u256 % TWO_POW_120.into()).try_into().unwrap()
    }

    fn create_enc_note(self: @User, create_note_input: CreateEncNoteInput) -> Span<ServerAction> {
        self.execute([ClientAction::CreateEncNote(create_note_input)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_create_enc_note(
        self: @User, create_note_input: CreateEncNoteInput,
    ) -> Result<(), Array<felt252>> {
        self.safe_execute([ClientAction::CreateEncNote(create_note_input)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_create_enc_note_execute_and_panic(
        self: @User, create_note_input: CreateEncNoteInput,
    ) -> Result<(), Array<felt252>> {
        self.safe_execute_and_panic([ClientAction::CreateEncNote(create_note_input)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_create_enc_note_execute_view(
        self: @User, create_note_input: CreateEncNoteInput,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self.safe_execute_view([ClientAction::CreateEncNote(create_note_input)].span())
    }

    fn internal_create_enc_note(
        self: @User, create_note_input: CreateEncNoteInput,
    ) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let mut token_balances: TokenBalances = Default::default();
                token_balances
                    .add_balance(token: create_note_input.token, amount: create_note_input.amount);
                state
                    .create_enc_note(
                        sender_addr: *self.address,
                        sender_private_key: *self.private_key,
                        input: create_note_input,
                        ref :token_balances,
                    )
            },
        )
            .span()
    }

    fn cheat_create_enc_note_e2e(self: @User, create_note_input: CreateEncNoteInput) {
        self.privacy.apply_actions(actions: self.internal_create_enc_note(create_note_input));
    }

    fn create_open_note(self: @User, create_note_input: CreateOpenNoteInput) -> Span<ServerAction> {
        self.execute([ClientAction::CreateOpenNote(create_note_input)].span())
    }

    fn safe_create_open_note(
        self: @User, create_note_input: CreateOpenNoteInput,
    ) -> Result<(), Array<felt252>> {
        self.safe_execute([ClientAction::CreateOpenNote(create_note_input)].span())
    }

    fn safe_create_open_note_execute_and_panic(
        self: @User, create_note_input: CreateOpenNoteInput,
    ) -> Result<(), Array<felt252>> {
        self.safe_execute_and_panic([ClientAction::CreateOpenNote(create_note_input)].span())
    }

    fn safe_create_open_note_execute_view(
        self: @User, create_note_input: CreateOpenNoteInput,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self.safe_execute_view([ClientAction::CreateOpenNote(create_note_input)].span())
    }

    fn internal_create_open_note(
        self: @User, create_note_input: CreateOpenNoteInput,
    ) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                state
                    .create_open_note(
                        sender_addr: *self.address,
                        sender_private_key: *self.private_key,
                        input: create_note_input,
                    )
            },
        )
            .span()
    }

    fn cheat_create_open_note_e2e(self: @User, create_note_input: CreateOpenNoteInput) {
        self.privacy.apply_actions(actions: self.internal_create_open_note(create_note_input));
    }

    fn compute_channel_key(self: @User, recipient: User) -> felt252 {
        compute_channel_key(
            sender_addr: *self.address,
            sender_private_key: *self.private_key,
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
        )
    }

    fn compute_outgoing_channel_id(self: @User, index: usize) -> felt252 {
        compute_outgoing_channel_id(
            sender_addr: *self.address, sender_private_key: *self.private_key, :index,
        )
    }

    fn compute_enc_outgoing_channel_info(
        self: @User, recipient: User, index: usize, salt: felt252,
    ) -> EncOutgoingChannelInfo {
        encrypt_outgoing_channel_info(
            sender_addr: *self.address,
            sender_private_key: *self.private_key,
            :index,
            recipient_addr: recipient.address,
            :salt,
        )
    }

    fn compute_channel_marker(self: @User, recipient: User) -> felt252 {
        compute_channel_marker(
            channel_key: self.compute_channel_key(:recipient),
            sender_addr: *self.address,
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
        )
    }

    fn compute_subchannel_id(self: @User, recipient: User, index: usize) -> felt252 {
        let channel_key = self.compute_channel_key(:recipient);
        compute_subchannel_id(:channel_key, :index)
    }

    fn compute_subchannel_marker(
        self: @User, recipient: User, token_addr: ContractAddress,
    ) -> felt252 {
        compute_subchannel_marker(
            channel_key: self.compute_channel_key(:recipient),
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            token: token_addr,
        )
    }

    fn compute_enc_subchannel_info(
        self: @User, recipient: User, token_addr: ContractAddress, index: usize, salt: felt252,
    ) -> EncSubchannelInfo {
        let channel_key = self.compute_channel_key(:recipient);
        encrypt_subchannel_info(:channel_key, :index, token: token_addr, :salt)
    }

    /// Computes the note ID and Note for a given CreateEncNoteInput.
    /// Returns (note_id, Note).
    fn compute_enc_note(self: @User, create_note_input: CreateEncNoteInput) -> (felt252, Note) {
        let channel_key = compute_channel_key(
            sender_addr: *self.address,
            sender_private_key: *self.private_key,
            recipient_addr: create_note_input.recipient_addr,
            recipient_public_key: create_note_input.recipient_public_key,
        );
        let note_id = compute_note_id(
            :channel_key, token: create_note_input.token, index: create_note_input.index,
        );
        let packed_value = enc_note_packed_value(
            :channel_key,
            token: create_note_input.token,
            index: create_note_input.index,
            salt: create_note_input.salt,
            amount: create_note_input.amount,
        );
        (note_id, Note { packed_value, token: Zero::zero(), depositor: Zero::zero() })
    }

    /// Computes the note ID and Note for a given CreateOpenNoteInput.
    /// Returns (note_id, Note).
    fn compute_open_note(self: @User, create_note_input: CreateOpenNoteInput) -> (felt252, Note) {
        let channel_key = compute_channel_key(
            sender_addr: *self.address,
            sender_private_key: *self.private_key,
            recipient_addr: create_note_input.recipient_addr,
            recipient_public_key: create_note_input.recipient_public_key,
        );
        let note_id = compute_note_id(
            :channel_key, token: create_note_input.token, index: create_note_input.index,
        );
        let packed_value = pack(value_1: OPEN_NOTE_SALT, value_2: Zero::zero());
        (
            note_id,
            Note {
                packed_value,
                token: create_note_input.token,
                depositor: create_note_input.depositor,
            },
        )
    }


    fn compute_enc_user_addr(self: @User, random: felt252) -> EncUserAddr {
        encrypt_user_addr(
            ephemeral_secret: random,
            auditor_public_key: self.privacy.get_auditor_public_key(),
            user_addr: *self.address,
        )
    }

    fn use_note(self: @User, note: UseNoteInput) -> Span<ServerAction> {
        self.execute(client_actions: [ClientAction::UseNote(note)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_use_note(self: @User, note: UseNoteInput) -> Result<(), Array<felt252>> {
        self.safe_execute(client_actions: [ClientAction::UseNote(note)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_use_note_execute_and_panic(
        self: @User, note: UseNoteInput,
    ) -> Result<(), Array<felt252>> {
        self.safe_execute_and_panic(client_actions: [ClientAction::UseNote(note)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_use_note_execute_view(
        self: @User, note: UseNoteInput,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self.safe_execute_view(client_actions: [ClientAction::UseNote(note)].span())
    }

    fn internal_use_note(self: @User, note: UseNoteInput) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let mut token_balances: TokenBalances = Default::default();
                state
                    .use_note(
                        owner_addr: *self.address,
                        owner_private_key: *self.private_key,
                        input: note,
                        ref :token_balances,
                    )
            },
        )
            .span()
    }

    fn compute_nullifier(
        self: @User, sender: User, token_addr: ContractAddress, index: usize,
    ) -> felt252 {
        compute_nullifier(
            channel_key: sender.compute_channel_key(recipient: *self),
            token: token_addr,
            :index,
            owner_private_key: *self.private_key,
        )
    }

    fn new_enc_note(
        self: @User,
        recipient: User,
        token_addr: ContractAddress,
        amount: u128,
        index: usize,
        salt: u128,
    ) -> CreateEncNoteInput {
        CreateEncNoteInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            token: token_addr,
            amount,
            index,
            salt,
        }
    }

    fn new_enc_note_with_generated_salt(
        ref self: User, recipient: User, token_addr: ContractAddress, amount: u128, index: usize,
    ) -> CreateEncNoteInput {
        let salt = self.get_salt();
        self.new_enc_note(:recipient, :token_addr, :amount, :index, :salt)
    }

    fn new_open_note(
        self: @User,
        recipient: User,
        token_addr: ContractAddress,
        index: usize,
        depositor: ContractAddress,
        random: felt252,
    ) -> CreateOpenNoteInput {
        CreateOpenNoteInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            token: token_addr,
            index,
            depositor,
            random,
        }
    }

    fn new_open_note_with_generated_random(
        ref self: User,
        recipient: User,
        token_addr: ContractAddress,
        index: usize,
        depositor: ContractAddress,
    ) -> CreateOpenNoteInput {
        let random = self.get_random();
        self.new_open_note(:recipient, :token_addr, :index, :depositor, :random)
    }

    fn deposit_and_create_note_e2e(ref self: User, token: Token, amount: u128) {
        let salt = self.get_salt();
        let deposit_input = DepositInput { token: token.contract_address(), amount };
        let create_note_input = CreateEncNoteInput {
            recipient_addr: self.address,
            recipient_public_key: self.public_key,
            token: token.contract_address(),
            amount,
            index: 0,
            salt,
        };
        self.increase_token_balance(:token, :amount);
        self.approve(:token, amount: amount.into());
        let server_actions = self
            .execute(
                [
                    ClientAction::Deposit(deposit_input),
                    ClientAction::CreateEncNote(create_note_input),
                ]
                    .span(),
            );
        self.privacy.apply_actions(actions: server_actions);
    }

    fn internal_deposit(
        self: @User, token_addr: ContractAddress, amount: u128,
    ) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let mut token_balances: TokenBalances = Default::default();
                let input = DepositInput { token: token_addr, amount };
                state.deposit(user_addr: *self.address, :input, ref :token_balances)
            },
        )
            .span()
    }

    fn safe_deposit(
        self: @User, token_addr: ContractAddress, amount: u128,
    ) -> Result<(), Array<felt252>> {
        let input = DepositInput { token: token_addr, amount };
        self.safe_execute(client_actions: [ClientAction::Deposit(input),].span())
    }

    fn get_num_of_channels(self: @User) -> u64 {
        self.privacy.views.get_num_of_channels(recipient_addr: *self.address)
    }

    fn get_channel_info(self: @User, channel_index: u64) -> EncChannelInfo {
        self.privacy.views.get_channel_info(recipient_addr: *self.address, :channel_index)
    }

    #[feature("safe_dispatcher")]
    fn safe_get_channel_info(
        self: @User, channel_index: u64,
    ) -> Result<EncChannelInfo, Array<felt252>> {
        self.privacy.safe_views.get_channel_info(recipient_addr: *self.address, :channel_index)
    }

    fn set_viewing_key(self: @User, random: felt252) -> Span<ServerAction> {
        let input = SetViewingKeyInput { random };
        self.execute(client_actions: [ClientAction::SetViewingKey(input)].span())
    }

    fn internal_set_viewing_key(self: @User, random: felt252) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let input = SetViewingKeyInput { random };
                state
                    .set_viewing_key(
                        user_addr: *self.address, user_private_key: *self.private_key, :input,
                    )
            },
        )
            .span()
    }

    /// Returns (random, output) where output is the output of `set_viewing_key`.
    fn internal_set_viewing_key_with_generated_random(
        ref self: User,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random();
        let actions = self.internal_set_viewing_key(:random);
        (random, actions)
    }

    /// Returns the random value generated by the user for `set_viewing_key`.
    fn set_viewing_key_e2e(ref self: User) -> felt252 {
        let random = self.get_random();
        self.set_viewing_key_e2e_with_random(:random);
        random
    }

    fn set_viewing_key_e2e_with_random(ref self: User, random: felt252) {
        let actions = self.set_viewing_key(:random);
        self.privacy.apply_actions(:actions);
    }

    fn safe_set_viewing_key(self: @User, random: felt252) -> Result<(), Array<felt252>> {
        let input = SetViewingKeyInput { random };
        self.safe_execute(client_actions: [ClientAction::SetViewingKey(input)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_set_viewing_key_execute_and_panic(
        self: @User, random: felt252,
    ) -> Result<(), Array<felt252>> {
        let input = SetViewingKeyInput { random };
        self.safe_execute_and_panic(client_actions: [ClientAction::SetViewingKey(input)].span())
    }

    #[feature("safe_dispatcher")]
    fn safe_set_viewing_key_execute_view(
        self: @User, random: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .safe_execute_view(
                client_actions: [ClientAction::SetViewingKey(SetViewingKeyInput { random })].span(),
            )
    }

    fn get_public_key(self: @User) -> felt252 {
        self.privacy.views.get_public_key(user_addr: *self.address)
    }

    fn get_enc_private_key(self: @User) -> EncPrivateKey {
        self.privacy.views.get_enc_private_key(user_addr: *self.address)
    }

    fn compute_enc_private_key(self: @User, random: felt252) -> EncPrivateKey {
        encrypt_private_key(
            ephemeral_secret: random,
            auditor_public_key: self.privacy.get_auditor_public_key(),
            private_key: *self.private_key,
        )
    }

    /// Generate a new private and public key.
    fn new_key(ref self: User) {
        let mut private_key = self.private_key * 2;
        if !is_canonical_key(key: private_key) {
            private_key = Neg::neg(private_key);
        }
        self.private_key = private_key;
        self.public_key = derive_public_key(:private_key);
    }

    fn approve(self: @User, token: Token, amount: u256) {
        token.approve(owner: *self.address, spender: *self.privacy.address, :amount);
    }

    /// Execute deposit_to_open_note as this user (caller).
    /// Assumes the user already has sufficient token balance and approval.
    fn deposit_to_open_note(
        self: @User, note_id: felt252, token_addr: ContractAddress, amount: u128,
    ) {
        cheat_caller_address_once(
            contract_address: *self.privacy.address, caller_address: *self.address,
        );
        self.privacy.deposit_to_open_note(:note_id, :token_addr, :amount);
    }

    /// Safe version of `deposit_to_open_note` that returns a Result.
    /// Assumes the user already has sufficient token balance and approval.
    fn safe_deposit_to_open_note(
        self: @User, note_id: felt252, token_addr: ContractAddress, amount: u128,
    ) -> Result<(), Array<felt252>> {
        cheat_caller_address_once(
            contract_address: *self.privacy.address, caller_address: *self.address,
        );
        self.privacy.safe_deposit_to_open_note(:note_id, :token_addr, :amount)
    }

    /// Fund the user, approve, and deposit to an open note.
    fn fund_and_deposit_to_open_note(self: @User, token: Token, note_id: felt252, amount: u128) {
        self.increase_token_balance(:token, :amount);
        self.approve(:token, amount: amount.into());
        self.deposit_to_open_note(:note_id, token_addr: token.contract_address(), :amount);
    }

    /// Cheat deposit in the server side (no client side).
    fn cheat_deposit(
        self: @User, token: Token, amount: u128, create_note_input: CreateEncNoteInput,
    ) {
        self.approve(:token, amount: amount.into());
        let actions = [
            create_note_input.into_server_action(user: *self),
            ServerAction::TransferFrom(
                TransferFromInput {
                    from_addr: *self.address, token: token.contract_address(), amount,
                },
            ),
        ]
            .span();
        self.privacy.apply_actions(:actions);
    }

    /// Cheat withdraw in the server side (no client side).
    fn cheat_withdraw(
        self: @User, to_addr: ContractAddress, token: Token, amount: u128, nullifier: felt252,
    ) {
        let actions = [
            to_write_once_action(
                storage_address: map_entry_address(
                    map_selector: selector!("nullifiers"), keys: [nullifier].span(),
                ),
                value: true,
            ),
            ServerAction::TransferTo(
                TransferToInput { to_addr, token: token.contract_address(), amount },
            ),
        ]
            .span();
        self.privacy.apply_actions(:actions);
    }

    fn increase_token_balance(self: @User, token: Token, amount: u128) {
        token.supply(address: *self.address, :amount);
    }

    fn invoke_external_mock_swap_executor_input(
        self: @User,
        in_token: ContractAddress,
        out_token: ContractAddress,
        amount: u128,
        note_id: felt252,
    ) -> InvokeExternalInput {
        let calldata = build_swap_executor_calldata(
            :in_token, :out_token, in_amount: amount, :note_id,
        );
        InvokeExternalInput {
            contract_address: *self.privacy.swap_executor.address, calldata: calldata.span(),
        }
    }
}

#[derive(Drop, Copy)]
pub(crate) struct Auditor {
    pub private_key: felt252,
    pub public_key: felt252,
}

#[generate_trait]
pub(crate) impl AuditorImpl of AuditorTrait {
    fn decrypt_private_key(self: @Auditor, enc_private_key: EncPrivateKey) -> felt252 {
        decrypt_private_key(:enc_private_key, auditor_private_key: *self.private_key)
    }

    fn decrypt_user_addr(self: @Auditor, enc_user_addr: EncUserAddr) -> ContractAddress {
        decrypt_enc_user_addr(:enc_user_addr, auditor_private_key: *self.private_key)
    }
}

impl DefaultAuditorImpl of Default<Auditor> {
    fn default() -> Auditor {
        let private_key = 'AUDITOR_PRIVATE_KEY';
        let public_key = derive_public_key(:private_key);
        Auditor { private_key, public_key }
    }
}

#[derive(Drop, Copy)]
pub(crate) struct Test {
    pub privacy: PrivacyCfg,
    pub nonce: usize,
    pub auditor: Auditor,
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_user(ref self: Test) -> User {
        self.new_user_with_is_valid(is_valid: true)
    }

    fn new_user_with_is_valid(ref self: Test, is_valid: bool) -> User {
        self.nonce += 1;
        let mut private_key = 'PRIVATE_KEY' + self.nonce.into();
        if !is_canonical_key(key: private_key) {
            private_key = Neg::neg(private_key);
        }
        let public_key = derive_public_key(:private_key);
        self.nonce += 1;
        let address = deploy_mock_account(salt: self.nonce.into(), :is_valid);
        User { address, privacy: self.privacy, private_key, public_key, nonce: Zero::zero() }
    }

    /// Mock function to generate a new token address.
    fn mock_new_token(ref self: Test) -> ContractAddress {
        self.nonce += 1;
        ('TOKEN_ADDRESS' + self.nonce.into()).try_into().unwrap()
    }

    /// Mock function to generate a new depositor address.
    fn mock_new_depositor(ref self: Test) -> ContractAddress {
        self.nonce += 1;
        ('DEPOSITOR' + self.nonce.into()).try_into().unwrap()
    }

    /// Mock function to generate a new auditor encrypted private key.
    fn mock_new_enc_private_key(ref self: Test) -> EncPrivateKey {
        self.nonce += 1;
        EncPrivateKey {
            auditor_public_key: self.auditor.public_key,
            ephemeral_pubkey: 'EPHEMERAL_PUBKEY' + self.nonce.into(),
            enc_private_key: 'ENC_PRIVATE_KEY' + self.nonce.into(),
        }
    }

    /// Mock function to generate a new enc address.
    fn mock_new_enc_address(ref self: Test) -> EncUserAddr {
        self.nonce += 1;
        EncUserAddr {
            auditor_public_key: self.auditor.public_key,
            ephemeral_pubkey: 'EPHEMERAL_PUBKEY' + self.nonce.into(),
            enc_user_addr: 'ENC_USER_ADDR' + self.nonce.into(),
        }
    }

    /// Mock function to generate a new note.
    /// Returns (enc_channel_info, channel_marker).
    fn mock_new_channel(ref self: Test) -> (EncChannelInfo, felt252) {
        self.nonce += 1;
        let enc_channel_info = EncChannelInfo {
            ephemeral_pubkey: 'EPHEMERAL_PUBKEY' + self.nonce.into(),
            enc_channel_key: 'ENC_CHANNEL_KEY' + self.nonce.into(),
            enc_sender_addr: 'ENC_SENDER_ADDR' + self.nonce.into(),
        };
        let channel_marker = 'CHANNEL_MARKER' + self.nonce.into();
        (enc_channel_info, channel_marker)
    }

    /// Mock function to generate a new subchannel.
    /// Returns (subchannel_marker, subchannel_id, enc_subchannel_info).
    fn mock_new_subchannel(ref self: Test) -> (felt252, felt252, EncSubchannelInfo) {
        self.nonce += 1;
        let subchannel_marker = 'SUBCHANNEL_MARKER' + self.nonce.into();
        let subchannel_id = 'SUBCHANNEL_ID' + self.nonce.into();
        let enc_subchannel_info = EncSubchannelInfo {
            salt: 'SALT' + self.nonce.into(), enc_token: 'ENC_TOKEN' + self.nonce.into(),
        };
        (subchannel_marker, subchannel_id, enc_subchannel_info)
    }

    /// Mock function to generate a new note.
    /// Returns (note_id, Note).
    fn mock_new_note(ref self: Test, amount: u128) -> (felt252, Note) {
        self.nonce += 1;
        let note_id = 'NOTE_ID' + self.nonce.into();
        let packed_value = 'PACKED_VALUE' + amount.into() + self.nonce.into();
        let token = self.mock_new_token();
        let depositor = self.mock_new_depositor();
        (note_id, Note { packed_value, token, depositor })
    }

    /// Mock function to generate a new nullifier.
    fn mock_new_nullifier(ref self: Test) -> felt252 {
        self.nonce += 1;
        'NULLIFIER' + self.nonce.into()
    }

    fn new_token(ref self: Test) -> Token {
        self.nonce += 1;
        let config = TokenConfig {
            name: format!("Token {}", self.nonce),
            symbol: format!("Token {}", self.nonce),
            decimals: constants::DECIMALS,
            initial_supply: constants::TOKEN_SUPPLY,
            owner: constants::TOKEN_OWNER,
        };
        let token = config.deploy();

        Token::Custom(
            CustomToken {
                contract_address: token.address,
                balances_variable_selector: selector!("ERC20_balances"),
            },
        )
    }

    fn replace_auditor_key(ref self: Test) {
        self.nonce += 1;
        self.auditor.private_key = 'AUDITOR_PRIVATE_KEY' + self.nonce.into();
        self.auditor.public_key = derive_public_key(private_key: self.auditor.private_key);
        self.privacy.set_auditor_public_key(auditor_public_key: self.auditor.public_key);
    }
}

#[generate_trait]
pub(crate) impl PrivacyCfgImpl of PrivacyCfgTrait {
    /// Cheat open a channel in the server side (no client side).
    fn cheat_open_channel(
        self: @PrivacyCfg,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannelInfo,
        channel_marker: felt252,
    ) {
        let actions = [
            to_write_once_action(
                storage_address: map_entry_address(
                    map_selector: selector!("channel_exists"), keys: [channel_marker].span(),
                ),
                value: true,
            ),
            ServerAction::Append(AppendInput { recipient_addr, enc_channel_info }),
        ]
            .span();
        self.apply_actions(:actions);
    }

    fn channel_exists(self: @PrivacyCfg, channel_marker: felt252) -> bool {
        self.views.channel_exists(:channel_marker)
    }

    fn subchannel_exists(self: @PrivacyCfg, subchannel_marker: felt252) -> bool {
        self.views.subchannel_exists(:subchannel_marker)
    }

    fn get_subchannel_info(self: @PrivacyCfg, subchannel_id: felt252) -> EncSubchannelInfo {
        self.views.get_subchannel_info(:subchannel_id)
    }

    fn get_outgoing_channel_info(
        self: @PrivacyCfg, outgoing_channel_id: felt252,
    ) -> EncOutgoingChannelInfo {
        self.views.get_outgoing_channel_info(:outgoing_channel_id)
    }

    /// Cheat create a note in the server side (no client side).
    fn cheat_create_note(self: @PrivacyCfg, note_id: felt252, note: Note) {
        let storage_address = map_entry_address(
            map_selector: selector!("notes"), keys: [note_id].span(),
        );
        self.apply_actions(actions: [to_write_once_action(:storage_address, value: note)].span())
    }

    fn get_note(self: @PrivacyCfg, note_id: felt252) -> Note {
        self.views.get_note(:note_id)
    }

    /// Cheat use a note in the server side (no client side).
    fn cheat_use_note(self: @PrivacyCfg, nullifier: felt252) {
        let storage_address = map_entry_address(
            map_selector: selector!("nullifiers"), keys: [nullifier].span(),
        );
        self
            .apply_actions(
                actions: array![to_write_once_action(:storage_address, value: true)].span(),
            )
    }

    fn nullifier_exists(self: @PrivacyCfg, nullifier: felt252) -> bool {
        self.views.nullifier_exists(:nullifier)
    }

    fn get_auditor_public_key(self: @PrivacyCfg) -> felt252 {
        self.views.get_auditor_public_key()
    }

    /// Supply STRK to `caller` and approve the privacy contract for the fee.
    fn _fund_fee(self: @PrivacyCfg, caller: ContractAddress) {
        let fee_amount = self.views.get_fee_amount();
        if fee_amount.is_non_zero() {
            self.strk_token.supply(address: caller, amount: fee_amount);
            self
                .strk_token
                .approve(owner: caller, spender: *self.address, amount: fee_amount.into());
        }
    }

    fn apply_actions(self: @PrivacyCfg, actions: Span<ServerAction>) {
        self.apply_actions_as(:actions, caller: constants::PAYMASTER);
    }

    #[feature("safe_dispatcher")]
    fn safe_apply_actions(
        self: @PrivacyCfg, actions: Span<ServerAction>,
    ) -> Result<(), Array<felt252>> {
        self.safe_apply_actions_as(:actions, caller: constants::PAYMASTER)
    }

    fn apply_actions_as(self: @PrivacyCfg, actions: Span<ServerAction>, caller: ContractAddress) {
        self._fund_fee(:caller);
        self.cheat_proof_facts(:actions);
        cheat_caller_address_once(contract_address: *self.address, caller_address: caller);
        self.server.apply_actions(:actions);
    }

    #[feature("safe_dispatcher")]
    fn safe_apply_actions_as(
        self: @PrivacyCfg, actions: Span<ServerAction>, caller: ContractAddress,
    ) -> Result<(), Array<felt252>> {
        self._fund_fee(:caller);
        self.cheat_proof_facts(:actions);
        cheat_caller_address_once(contract_address: *self.address, caller_address: caller);
        self.safe_server.apply_actions(:actions)
    }

    /// Like `safe_apply_actions_as` but without auto-funding the fee.
    /// Use this to test fee-related error conditions (e.g. insufficient balance/allowance).
    #[feature("safe_dispatcher")]
    fn safe_apply_actions_as_unfunded(
        self: @PrivacyCfg, actions: Span<ServerAction>, caller: ContractAddress,
    ) -> Result<(), Array<felt252>> {
        self.cheat_proof_facts(:actions);
        cheat_caller_address_once(contract_address: *self.address, caller_address: caller);
        self.safe_server.apply_actions(:actions)
    }

    #[feature("safe_dispatcher")]
    fn safe_apply_actions_without_cheat(
        self: @PrivacyCfg, actions: Span<ServerAction>,
    ) -> Result<(), Array<felt252>> {
        self.safe_server.apply_actions(:actions)
    }

    #[feature("safe_dispatcher")]
    fn safe_apply_actions_with_proof_facts(
        self: @PrivacyCfg, actions: Span<ServerAction>, proof_facts: ProofFacts,
    ) -> Result<(), Array<felt252>> {
        self._cheat_proof_facts(:proof_facts);
        self.safe_server.apply_actions(:actions)
    }

    fn deposit_to_open_note(
        self: @PrivacyCfg, note_id: felt252, token_addr: ContractAddress, amount: u128,
    ) {
        self.server.deposit_to_open_note(:note_id, token: token_addr, :amount);
    }

    #[feature("safe_dispatcher")]
    fn safe_deposit_to_open_note(
        self: @PrivacyCfg, note_id: felt252, token_addr: ContractAddress, amount: u128,
    ) -> Result<(), Array<felt252>> {
        self.safe_server.deposit_to_open_note(:note_id, token: token_addr, :amount)
    }

    fn pause(self: @PrivacyCfg) {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.roles.security_agent,
        );
        IPausableDispatcher { contract_address: *self.address }.pause();
    }

    fn increase_token_balance(self: @PrivacyCfg, token: Token, amount: u128) {
        token.supply(address: *self.address, :amount);
    }

    fn execute(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Span<ServerAction> {
        let calls = self.wrap_inputs_into_calls(:user_addr, :user_private_key, :client_actions);
        let mut spy = spy_messages_to_l1();
        self.client.__execute__(:calls);
        self.general_assert_spy_messages(ref :spy);
        spy_messages_to_server_actions(ref :spy)
    }

    fn execute_without_return(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) {
        let calls = self.wrap_inputs_into_calls(:user_addr, :user_private_key, :client_actions);
        self.client.__execute__(:calls);
    }

    #[feature("safe_dispatcher")]
    fn safe_execute(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Result<(), Array<felt252>> {
        let calls = self.wrap_inputs_into_calls(:user_addr, :user_private_key, :client_actions);
        self.safe_client.__execute__(:calls)
    }

    #[feature("safe_dispatcher")]
    fn safe_execute_with_calls(
        self: @PrivacyCfg, calls: Array<Call>,
    ) -> Result<(), Array<felt252>> {
        self.safe_client.__execute__(:calls)
    }

    #[feature("safe_dispatcher")]
    fn safe_execute_and_panic(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Result<(), Array<felt252>> {
        self.safe_client.execute_and_panic(:user_addr, :user_private_key, :client_actions)
    }

    #[feature("safe_dispatcher")]
    fn safe_execute_view(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self.safe_client.execute_view(:user_addr, :user_private_key, :client_actions)
    }

    #[feature("safe_dispatcher")]
    fn safe_validate(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Result<felt252, Array<felt252>> {
        let calls = self.wrap_inputs_into_calls(:user_addr, :user_private_key, :client_actions);
        self.safe_client.__validate__(:calls)
    }

    fn validate(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> felt252 {
        let calls = self.wrap_inputs_into_calls(:user_addr, :user_private_key, :client_actions);
        self.cheat_valid_execution_info();
        self.client.__validate__(:calls)
    }

    fn execute_view(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Span<ServerAction> {
        self.client.execute_view(:user_addr, :user_private_key, :client_actions)
    }

    /// Asserts the message from the spy is valid.
    fn general_assert_spy_messages(self: @PrivacyCfg, ref spy: MessageToL1Spy) {
        assert_eq!(spy.get_messages().messages.len(), 1);
        let (from, message) = spy.get_messages().messages.at(0);
        assert_eq!(*from, *self.address);
        assert_eq!(*message.to_address, Zero::zero());
    }

    fn cheat_valid_execution_info(self: @PrivacyCfg) {
        self.cheat_zero_caller_address();
        self.cheat_zero_resource_bounds();
    }

    fn cheat_zero_caller_address(self: @PrivacyCfg) {
        cheat_caller_address_once(contract_address: *self.address, caller_address: Zero::zero());
    }

    fn cheat_zero_resource_bounds(self: @PrivacyCfg) {
        let resource_bounds = ResourcesBounds {
            resource: Zero::zero(), max_amount: Zero::zero(), max_price_per_unit: Zero::zero(),
        };
        cheat_resource_bounds(
            contract_address: *self.address,
            resource_bounds: array![resource_bounds].span(),
            span: CheatSpan::TargetCalls(1),
        );
    }

    fn cheat_proof_facts(self: @PrivacyCfg, actions: Span<ServerAction>) {
        let message_hash = compute_message_hash(:actions, contract_address: *self.address);
        let mut proof_facts: ProofFacts = Default::default();
        proof_facts.message_to_l1_hashes = [message_hash].span();
        self._cheat_proof_facts(:proof_facts);
    }

    fn _cheat_proof_facts(self: @PrivacyCfg, proof_facts: ProofFacts) {
        let mut serialized_proof_facts = array![];
        proof_facts.serialize(ref serialized_proof_facts);
        cheat_proof_facts(
            contract_address: *self.address,
            proof_facts: serialized_proof_facts.span(),
            span: CheatSpan::TargetCalls(1),
        );
    }

    fn set_auditor_public_key(self: @PrivacyCfg, auditor_public_key: felt252) {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.roles.token_admin,
        );
        self.admin.set_auditor_public_key(:auditor_public_key);
    }

    #[feature("safe_dispatcher")]
    fn safe_set_auditor_public_key(
        self: @PrivacyCfg, auditor_public_key: felt252,
    ) -> Result<(), Array<felt252>> {
        self.safe_admin.set_auditor_public_key(:auditor_public_key)
    }

    fn set_fee_amount(self: @PrivacyCfg, fee_amount: u128) {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.roles.app_governor,
        );
        self.admin.set_fee_amount(:fee_amount);
    }

    fn set_fee_collector(self: @PrivacyCfg, fee_collector: ContractAddress) {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.roles.app_governor,
        );
        self.admin.set_fee_collector(:fee_collector);
    }

    #[feature("safe_dispatcher")]
    fn safe_set_fee_amount(self: @PrivacyCfg, fee_amount: u128) -> Result<(), Array<felt252>> {
        self.safe_admin.set_fee_amount(:fee_amount)
    }

    #[feature("safe_dispatcher")]
    fn safe_set_fee_collector(
        self: @PrivacyCfg, fee_collector: ContractAddress,
    ) -> Result<(), Array<felt252>> {
        self.safe_admin.set_fee_collector(:fee_collector)
    }

    fn set_proof_validity_blocks(self: @PrivacyCfg, proof_validity_blocks: u64) {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.roles.app_governor,
        );
        self.admin.set_proof_validity_blocks(:proof_validity_blocks);
    }

    #[feature("safe_dispatcher")]
    fn safe_set_proof_validity_blocks(
        self: @PrivacyCfg, proof_validity_blocks: u64,
    ) -> Result<(), Array<felt252>> {
        self.safe_admin.set_proof_validity_blocks(:proof_validity_blocks)
    }

    fn get_fee_amount(self: @PrivacyCfg) -> u128 {
        self.views.get_fee_amount()
    }

    fn get_fee_collector(self: @PrivacyCfg) -> ContractAddress {
        self.views.get_fee_collector()
    }

    fn get_proof_validity_blocks(self: @PrivacyCfg) -> u64 {
        self.views.get_proof_validity_blocks()
    }

    fn store_zero(self: @PrivacyCfg, storage_address: felt252) {
        store(target: *self.address, :storage_address, serialized_value: [Zero::zero()].span());
    }

    fn pop_from_vec(self: @PrivacyCfg, recipient_addr: ContractAddress) {
        let target = *self.address;
        let vector_storage_address = map_entry_address(
            map_selector: selector!("recipient_channels"), keys: [recipient_addr.into()].span(),
        );
        let length: u64 = generic_load(:target, storage_address: vector_storage_address);
        let new_length = length - 1;
        // Store new length.
        store(
            :target,
            storage_address: vector_storage_address,
            serialized_value: [new_length.into()].span(),
        );
        // Store Zero.
        let storage_address = map_entry_address(
            map_selector: vector_storage_address, keys: [new_length.into()].span(),
        );
        self.store_zero(:storage_address);
        self.store_zero(storage_address: storage_address + 1);
    }

    fn wrap_inputs_into_calls(
        self: @PrivacyCfg,
        user_addr: ContractAddress,
        user_private_key: felt252,
        client_actions: Span<ClientAction>,
    ) -> Array<Call> {
        let mut calldata = array![];
        user_addr.serialize(ref calldata);
        user_private_key.serialize(ref calldata);
        client_actions.serialize(ref calldata);
        array![
            Call {
                to: *self.address, selector: selector!("execute_view"), calldata: calldata.span(),
            },
        ]
    }
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let auditor: Auditor = Default::default();
        let roles: Roles = Default::default();
        let privacy = deploy_privacy(
            :roles,
            auditor_public_key: auditor.public_key,
            proof_validity_blocks: DEFAULT_PROOF_VALIDITY_BLOCKS,
        );

        Test { privacy, nonce: Zero::zero(), auditor }
    }
}

pub(crate) fn _deploy_privacy(
    governance_admin: ContractAddress, auditor_public_key: felt252, proof_validity_blocks: u64,
) -> ContractAddress {
    let contract_class_hash = declare(contract: "Privacy")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_privacy_for_test(
        class_hash: *contract_class_hash,
        :deployment_params,
        :governance_admin,
        :auditor_public_key,
        :proof_validity_blocks,
    )
        .expect('Privacy deployment failed');
    contract_address
}

/// Deploy a new privacy contract and set the roles.
fn deploy_privacy(
    roles: Roles, auditor_public_key: felt252, proof_validity_blocks: u64,
) -> PrivacyCfg {
    let contract_address = _deploy_privacy(
        governance_admin: roles.governance_admin, :auditor_public_key, :proof_validity_blocks,
    );
    let roles = _set_privacy_roles(contract: contract_address, :roles);
    // TODO: Remove this from general deployment and only deploy when needed.
    let mock_amm = deploy_mock_amm();
    let swap_executor = deploy_mock_swap_executor(
        amm_address: mock_amm, selector: selector!("swap"),
    );
    PrivacyCfg {
        address: contract_address,
        roles,
        server: IServerDispatcher { contract_address },
        safe_server: IServerSafeDispatcher { contract_address },
        client: IClientDispatcher { contract_address },
        safe_client: IClientSafeDispatcher { contract_address },
        views: IViewsDispatcher { contract_address },
        safe_views: IViewsSafeDispatcher { contract_address },
        admin: IAdminDispatcher { contract_address },
        safe_admin: IAdminSafeDispatcher { contract_address },
        strk_token: Token::STRK,
        swap_executor: SwapExecutorCfg {
            address: swap_executor, privacy_address: contract_address,
        },
        mock_amm,
    }
}

fn _set_privacy_roles(contract: ContractAddress, roles: Roles) -> Roles {
    set_account_as_security_agent(
        :contract, account: roles.security_agent, security_admin: roles.governance_admin,
    );
    set_account_as_app_role_admin(
        :contract, account: roles.app_role_admin, governance_admin: roles.governance_admin,
    );
    set_account_as_token_admin(
        :contract, account: roles.token_admin, app_role_admin: roles.app_role_admin,
    );
    set_account_as_app_governor(
        :contract, account: roles.app_governor, app_role_admin: roles.app_role_admin,
    );
    roles
}

pub(crate) fn deploy_mock_account(salt: felt252, is_valid: bool) -> ContractAddress {
    let contract_class_hash = declare(contract: "MockAccount")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_account_for_test(
        class_hash: *contract_class_hash, :deployment_params, :is_valid,
    )
        .expect('MockAccount deployment failed');
    contract_address
}

/// Deploy the reentrancy mock (attempts to call apply_actions on the privacy contract when
/// invoked).
pub(crate) fn deploy_mock_reentrancy() -> ContractAddress {
    let class_hash = declare(contract: "MockReentrancy")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_reentrancy_for_test(
        class_hash: *class_hash, :deployment_params,
    )
        .expect('MockReentrancy deploy failed');
    contract_address
}

/// Deploy a new swap executor contract.
pub(crate) fn deploy_mock_swap_executor(
    amm_address: ContractAddress, selector: felt252,
) -> ContractAddress {
    let class_hash = declare(contract: "MockSwapExecutor")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_swap_executor_for_test(
        class_hash: *class_hash, :deployment_params, :amm_address, :selector,
    )
        .expect('MockSwapExecutor deploy failed');
    contract_address
}

/// Deploy a new mock AMM contract.
fn deploy_mock_amm() -> ContractAddress {
    let class_hash = declare(contract: "MockAMM").unwrap_syscall().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_amm_for_test(
        class_hash: *class_hash, :deployment_params,
    )
        .expect('MockAMM deployment failed');
    contract_address
}


#[generate_trait]
pub(crate) impl SwapExecutorCfgImpl of SwapExecutorCfgTrait {
    fn privacy_invoke(
        self: @SwapExecutorCfg,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
        note_id: felt252,
    ) {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.privacy_address,
        );
        ISwapExecutorDispatcher { contract_address: *self.address }
            .privacy_invoke(:in_token, :out_token, :in_amount, :note_id);
    }

    #[feature("safe_dispatcher")]
    fn safe_privacy_invoke(
        self: @SwapExecutorCfg,
        in_token: ContractAddress,
        out_token: ContractAddress,
        in_amount: u128,
        note_id: felt252,
    ) -> Result<(), Array<felt252>> {
        ISwapExecutorSafeDispatcher { contract_address: *self.address }
            .privacy_invoke(:in_token, :out_token, :in_amount, :note_id)
    }
}

/// Builds the calldata for a swap executor invocation.
pub(crate) fn build_swap_executor_calldata(
    in_token: ContractAddress, out_token: ContractAddress, in_amount: u128, note_id: felt252,
) -> Array<felt252> {
    let mut calldata: Array<felt252> = array![];
    in_token.serialize(ref calldata);
    out_token.serialize(ref calldata);
    in_amount.serialize(ref calldata);
    note_id.serialize(ref calldata);
    calldata
}

/// Creates an `InvokeInput` for the swap executor from the given swap parameters.
pub(crate) fn invoke_mock_swap_executor_input(
    swap_executor: ContractAddress,
    in_token: ContractAddress,
    out_token: ContractAddress,
    in_amount: u128,
    note_id: felt252,
) -> InvokeInput {
    let calldata = build_swap_executor_calldata(:in_token, :out_token, :in_amount, :note_id);
    InvokeInput { contract_address: swap_executor, calldata: calldata.span() }
}

/// Returns private_key decrypted from the given `enc_private_key` and
/// the auditor's `private_key`.
pub(crate) fn decrypt_private_key(
    enc_private_key: EncPrivateKey, auditor_private_key: felt252,
) -> felt252 {
    // Sanity check.
    assert_eq!(
        enc_private_key.auditor_public_key, derive_public_key(private_key: auditor_private_key),
    );
    // Find shared point.
    let shared_x = _find_shared_x(
        ephemeral_pubkey: enc_private_key.ephemeral_pubkey, private_key: auditor_private_key,
    );

    // Decrypt private key.
    enc_private_key.enc_private_key - compute_enc_private_key_hash(:shared_x)
}

/// Returns (channel_key, sender_addr) decrypted from the given `enc_channel_info` and
/// `recipient_private_key`.
pub(crate) fn decrypt_channel_info(
    enc_channel_info: EncChannelInfo, recipient_private_key: felt252,
) -> (felt252, ContractAddress) {
    // Find shared point.
    let shared_x = _find_shared_x(
        ephemeral_pubkey: enc_channel_info.ephemeral_pubkey, private_key: recipient_private_key,
    );

    // Decrypt channel key.
    let decrypted_channel_key = enc_channel_info.enc_channel_key
        - compute_enc_channel_key_hash(:shared_x);

    // Decrypt sender address.
    let decrypted_sender_addr = enc_channel_info.enc_sender_addr
        - compute_enc_sender_addr_hash(:shared_x);

    (decrypted_channel_key, decrypted_sender_addr.try_into().unwrap())
}

pub(crate) fn decrypt_subchannel_token(
    enc_subchannel_info: EncSubchannelInfo, channel_key: felt252, index: usize,
) -> ContractAddress {
    let token = enc_subchannel_info.enc_token
        - compute_enc_token_hash(:channel_key, :index, salt: enc_subchannel_info.salt);
    token.try_into().unwrap()
}

pub(crate) fn decrypt_enc_user_addr(
    enc_user_addr: EncUserAddr, auditor_private_key: felt252,
) -> ContractAddress {
    // Sanity check.
    assert_eq!(
        enc_user_addr.auditor_public_key, derive_public_key(private_key: auditor_private_key),
    );
    // Decrypt user address.
    let shared_x = _find_shared_x(
        ephemeral_pubkey: enc_user_addr.ephemeral_pubkey, private_key: auditor_private_key,
    );
    let user_addr = enc_user_addr.enc_user_addr - compute_enc_user_addr_hash(:shared_x);
    user_addr.try_into().unwrap()
}

pub(crate) fn decrypt_outgoing_channel_info(
    enc_outgoing_channel_info: EncOutgoingChannelInfo,
    sender_addr: ContractAddress,
    sender_private_key: felt252,
    index: usize,
) -> ContractAddress {
    let recipient_addr = enc_outgoing_channel_info.enc_recipient_addr
        - compute_enc_recipient_addr_hash(
            :sender_addr, :sender_private_key, :index, salt: enc_outgoing_channel_info.salt,
        );
    recipient_addr.try_into().unwrap()
}

fn _find_shared_x(ephemeral_pubkey: felt252, private_key: felt252) -> felt252 {
    let ephemeral_pubkey_point = EcPointTrait::new_from_x(x: ephemeral_pubkey).unwrap();
    let shared_point = ephemeral_pubkey_point.mul(scalar: private_key);
    shared_point.try_into().unwrap().x()
}

fn deserialize_server_actions(message: @MessageToL1) -> Span<ServerAction> {
    let mut payload = message.payload.span();
    let _ = payload.pop_front(); // Pop class hash.
    Serde::<Span<ServerAction>>::deserialize(ref payload).expect('Failed deserialize')
}

pub(crate) fn spy_messages_to_server_actions(ref spy: MessageToL1Spy) -> Span<ServerAction> {
    let (_from, message) = spy.get_messages().messages.at(0);
    deserialize_server_actions(:message)
}
