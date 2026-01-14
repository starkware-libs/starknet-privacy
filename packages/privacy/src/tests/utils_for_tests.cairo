use core::ec::EcPointTrait;
use core::num::traits::Zero;
use core::traits::Neg;
use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::actions::{
    AppendToVecInput, ClientAction, CreateNoteInput, DepositInput, OpenChannelInput,
    OpenSubchannelInput, ServerAction, SetViewingKeyInput, TransferFromInput, TransferToInput,
    UseNoteInput, WithdrawInput, WriteIfZeroInput,
};
use privacy::hashes::{
    compute_channel_id, compute_channel_key, compute_enc_channel_key_hash,
    compute_enc_private_key_hash, compute_enc_sender_addr_hash, compute_enc_token_hash,
    compute_note_id, compute_nullifier, compute_subchannel_id, compute_subchannel_key, hash,
};
use privacy::interface::{
    IClientDispatcher, IClientDispatcherTrait, IClientSafeDispatcher, IClientSafeDispatcherTrait,
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
    IViewsDispatcher, IViewsDispatcherTrait, IViewsSafeDispatcher, IViewsSafeDispatcherTrait,
};
use privacy::objects::{
    EncChannelInfo, EncPrivateKey, EncSubchannelInfo, TokenBalances, TokenBalancesTrait,
};
use privacy::privacy::Privacy;
use privacy::privacy::Privacy::{ClientInternalTrait, deploy_for_test as deploy_privacy_for_test};
use privacy::tests::mock_account::MockAccount::deploy_for_test as deploy_mock_account_for_test;
use privacy::tests::mock_client::MockClient::deploy_for_test as deploy_mock_client_for_test;
use privacy::tests::mock_client::{IMockClientDispatcher, IMockClientDispatcherTrait};
use privacy::utils::constants::TWO_POW_120;
use privacy::utils::{
    derive_public_key, encrypt_note_amount, encrypt_private_key, encrypt_subchannel_info,
    is_canonical_key,
};
use snforge_std::{
    CustomToken, DeclareResultTrait, MessageToL1, MessageToL1Spy, MessageToL1SpyTrait, Token,
    TokenTrait, declare, interact_with_state, map_entry_address, set_balance, spy_messages_to_l1,
    store,
};
use starknet::deployment::DeploymentParams;
use starknet::storage::StorableStoragePointerReadAccess;
use starknet::{ContractAddress, SyscallResultTrait};
use starkware_utils::components::pausable::interface::{
    IPausableDispatcher, IPausableDispatcherTrait,
};
use starkware_utils_testing::test_utils::{
    Deployable, TokenConfig, cheat_caller_address_once, generic_load, set_account_as_security_agent,
};

pub(crate) mod constants {
    use core::num::traits::Pow;
    use starknet::ContractAddress;

    pub const DECIMALS: u8 = 18;
    pub const TOKEN_SUPPLY: u256 = 10_u256.pow(12 + DECIMALS.into());
    pub const TOKEN_OWNER: ContractAddress = 'TOKEN_OWNER'.try_into().unwrap();
    pub const DEFAULT_AMOUNT: u128 = 10_u128.pow(DECIMALS.into());
}

// TODO: Consider removing this struct.
/// An encrypted note, to be written to storage.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct EncNote {
    /// The note's id.
    pub id: felt252,
    /// The encrypted amount of the note.
    pub enc_amount: felt252,
}

#[generate_trait]
pub(crate) impl EncNoteImpl of EncNoteTrait {
    fn to_server_actions(self: @EncNote) -> Span<ServerAction> {
        let storage_path = map_entry_address(
            map_selector: selector!("notes"), keys: [*self.id].span(),
        );
        [
            ServerAction::WriteIfZero(
                WriteIfZeroInput { storage_address: storage_path, value: *self.enc_amount },
            ),
        ]
            .span()
    }
}

#[derive(Copy, Drop)]
pub(crate) struct PrivacyCfg {
    pub address: ContractAddress,
    pub governance_admin: ContractAddress,
    server: IServerDispatcher,
    safe_server: IServerSafeDispatcher,
    client: IClientDispatcher,
    safe_client: IClientSafeDispatcher,
    views: IViewsDispatcher,
    safe_views: IViewsSafeDispatcher,
}

#[derive(Copy, Drop)]
struct User {
    pub address: ContractAddress,
    pub privacy: PrivacyCfg,
    pub mock_client: MockClientCfg,
    pub private_key: felt252,
    pub public_key: felt252,
    nonce: usize,
}

// TODO: Rename compile_client_actions to execute.

#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn compile_client_actions(self: @User, client_actions: Span<ClientAction>) {
        self.privacy.execute(user_addr: *self.address, :client_actions)
    }

    #[feature("safe_dispatcher")]
    fn safe_compile_client_actions(
        self: @User, client_actions: Span<ClientAction>,
    ) -> Result<(), Array<felt252>> {
        self.privacy.safe_execute(user_addr: *self.address, :client_actions)
    }

    #[feature("safe_dispatcher")]
    fn safe_compile_client_actions_without_cheat_caller(
        self: @User, client_actions: Span<ClientAction>,
    ) -> Result<(), Array<felt252>> {
        self.privacy.safe_client.__execute__(user_addr: *self.address, :client_actions)
    }

    fn compile_client_actions_revert(
        self: @User, client_actions: Span<ClientAction>,
    ) -> Span<ServerAction> {
        self.mock_client.execute(user_addr: *self.address, :client_actions)
    }

    fn transfer(
        self: @User, notes_to_use: Span<UseNoteInput>, notes_to_create: Span<CreateNoteInput>,
    ) -> Span<ServerAction> {
        let mut client_actions: Array<ClientAction> = array![];
        for note in notes_to_use {
            client_actions.append(ClientAction::UseNote(*note));
        }
        for note in notes_to_create {
            client_actions.append(ClientAction::CreateNote(*note));
        }
        let mut spy = spy_messages_to_l1();
        self.compile_client_actions(client_actions: client_actions.span());
        spy_messages_to_server_actions(ref :spy)
    }

    #[feature("safe_dispatcher")]
    fn safe_transfer(
        self: @User, notes_to_use: Span<UseNoteInput>, notes_to_create: Span<CreateNoteInput>,
    ) -> Result<(), Array<felt252>> {
        let mut client_actions: Array<ClientAction> = array![];
        for note in notes_to_use {
            client_actions.append(ClientAction::UseNote(*note));
        }
        for note in notes_to_create {
            client_actions.append(ClientAction::CreateNote(*note));
        }
        self.safe_compile_client_actions(client_actions: client_actions.span())
    }

    fn withdraw(
        self: @User, withdrawal_target: ContractAddress, token: Token, amount: u128,
    ) -> Span<ServerAction> {
        let input = WithdrawInput { withdrawal_target, token: token.contract_address(), amount };
        self.compile_client_actions_revert(client_actions: [ClientAction::Withdraw(input)].span())
    }

    fn internal_withdraw(
        self: @User,
        withdrawal_target: ContractAddress,
        token_address: ContractAddress,
        amount: u128,
    ) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let mut token_balances: TokenBalances = Default::default();
                token_balances.add_balance(token: token_address, :amount);
                let input = WithdrawInput { withdrawal_target, token: token_address, amount };
                state.withdraw(:input, ref :token_balances)
            },
        )
            .span()
    }

    #[feature("safe_dispatcher")]
    fn safe_withdraw(
        self: @User,
        withdrawal_target: ContractAddress,
        token_address: ContractAddress,
        amount: u128,
    ) -> Result<(), Array<felt252>> {
        let input = WithdrawInput { withdrawal_target, token: token_address, amount };
        self.safe_compile_client_actions(client_actions: [ClientAction::Withdraw(input)].span())
    }

    fn open_channel(self: @User, recipient: User, random: felt252) -> Span<ServerAction> {
        let input = OpenChannelInput {
            sender_private_key: *self.private_key,
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            random,
        };
        self
            .compile_client_actions_revert(
                client_actions: [ClientAction::OpenChannel(input)].span(),
            )
    }

    fn internal_open_channel(self: @User, recipient: User, random: felt252) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let input = OpenChannelInput {
                    sender_private_key: *self.private_key,
                    recipient_addr: recipient.address,
                    recipient_public_key: recipient.public_key,
                    random,
                };
                state.open_channel(sender_addr: *self.address, :input)
            },
        )
            .span()
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel(
        self: @User, recipient: User, random: felt252,
    ) -> Result<(), Array<felt252>> {
        let input = OpenChannelInput {
            sender_private_key: *self.private_key,
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            random,
        };
        self.safe_compile_client_actions(client_actions: [ClientAction::OpenChannel(input)].span())
    }

    /// Returns (random, output) where output is the output of `open_channel`.
    fn internal_open_channel_with_generated_random(
        ref self: User, recipient: User,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random().into();
        let output = self.internal_open_channel(:recipient, :random);
        (random, output)
    }

    /// Returns the random value generated by the user for the channel opening.
    fn open_channel_e2e(ref self: User, recipient: User) -> felt252 {
        let random = self.get_random().into();
        let actions = self.open_channel(:recipient, :random);
        self.privacy.server.execute_actions(:actions);
        random
    }

    fn open_subchannel(
        self: @User, recipient: User, token_address: ContractAddress, index: usize, random: felt252,
    ) -> Span<ServerAction> {
        let channel_key = self.compute_channel_key(:recipient);
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_address,
            random,
        };
        self
            .compile_client_actions_revert(
                client_actions: [ClientAction::OpenSubchannel(input),].span(),
            )
    }

    fn internal_open_subchannel(
        self: @User, recipient: User, token_address: ContractAddress, index: usize, random: felt252,
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
                    token: token_address,
                    random,
                };
                state.open_subchannel(sender_addr: *self.address, :input)
            },
        )
            .span()
    }

    #[feature("safe_dispatcher")]
    fn safe_open_subchannel(
        self: @User, recipient: User, token_address: ContractAddress, index: usize, random: felt252,
    ) -> Result<(), Array<felt252>> {
        let channel_key = self.compute_channel_key(:recipient);
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_address,
            random,
        };
        self
            .safe_compile_client_actions(
                client_actions: [ClientAction::OpenSubchannel(input),].span(),
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_open_subchannel_with_channel_key(
        self: @User,
        recipient: User,
        token_address: ContractAddress,
        index: usize,
        random: felt252,
        channel_key: felt252,
    ) -> Result<(), Array<felt252>> {
        let input = OpenSubchannelInput {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            channel_key,
            index,
            token: token_address,
            random,
        };
        self
            .safe_compile_client_actions(
                client_actions: [ClientAction::OpenSubchannel(input),].span(),
            )
    }

    /// Returns (random, output) where output is the output of `open_subchannel`.
    fn internal_open_subchannel_with_generated_random(
        ref self: User, recipient: User, token_address: ContractAddress, index: usize,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random().into();
        let output = self.internal_open_subchannel(:recipient, :token_address, :index, :random);
        (random, output)
    }

    /// Returns the random value generated by the user for the subchannel opening.
    fn open_subchannel_e2e(
        ref self: User, recipient: User, token_address: ContractAddress, index: usize,
    ) -> felt252 {
        let random = self.get_random().into();
        let actions = self.open_subchannel(:recipient, :token_address, :index, :random);
        self.privacy.server.execute_actions(:actions);
        random
    }

    /// Open a channel and a subchannel with the given token.
    /// Returns (random_generated_for_channel, random_generated_for_subchannel).
    fn open_channel_with_token_e2e(
        ref self: User, recipient: User, token_address: ContractAddress, subchannel_index: usize,
    ) -> (felt252, felt252) {
        let random_channel = self.open_channel_e2e(:recipient);
        let random_subchannel = self
            .open_subchannel_e2e(:recipient, :token_address, index: subchannel_index);
        (random_channel, random_subchannel)
    }

    /// Returns a random value of 120 bits.
    fn get_random(ref self: User) -> u128 {
        self.nonce += 1;
        let hash_u256: u256 = hash(['RANDOM', self.nonce.into()].span()).into();
        (hash_u256 % TWO_POW_120.into()).try_into().expect('RANDOM_OVERFLOW')
    }

    fn create_note(self: @User, note: CreateNoteInput) -> Span<ServerAction> {
        self.compile_client_actions_revert([ClientAction::CreateNote(note)].span())
    }

    fn internal_create_note(self: @User, note: CreateNoteInput) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let mut token_balances: TokenBalances = Default::default();
                token_balances.add_balance(token: note.token, amount: note.amount);
                state.create_note(owner_addr: *self.address, input: note, ref :token_balances)
            },
        )
            .span()
    }

    fn cheat_create_note_e2e(self: @User, note: CreateNoteInput) {
        self.privacy.server.execute_actions(actions: self.internal_create_note(note));
    }

    fn compute_channel_key(self: @User, recipient: User) -> felt252 {
        compute_channel_key(
            sender_addr: *self.address,
            sender_private_key: *self.private_key,
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
        )
    }

    fn compute_channel_id(self: @User, recipient: User) -> felt252 {
        compute_channel_id(
            channel_key: self.compute_channel_key(:recipient),
            sender_addr: *self.address,
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
        )
    }

    fn compute_subchannel_key(self: @User, recipient: User, index: usize) -> felt252 {
        let channel_key = self.compute_channel_key(:recipient);
        compute_subchannel_key(:channel_key, :index)
    }

    fn compute_subchannel_id(
        self: @User, recipient: User, token_address: ContractAddress,
    ) -> felt252 {
        compute_subchannel_id(
            channel_key: self.compute_channel_key(:recipient),
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            token: token_address,
        )
    }

    fn compute_enc_subchannel_info(
        self: @User, recipient: User, token_address: ContractAddress, random: felt252,
    ) -> EncSubchannelInfo {
        let channel_key = self.compute_channel_key(:recipient);
        encrypt_subchannel_info(:channel_key, token: token_address, :random)
    }

    fn compute_enc_note(
        self: @User,
        recipient: User,
        token_address: ContractAddress,
        index: usize,
        amount: u128,
        random: u128,
    ) -> EncNote {
        let channel_key = self.compute_channel_key(:recipient);
        let note_id = compute_note_id(:channel_key, token: token_address, :index);
        let enc_amount = encrypt_note_amount(:channel_key, :random, :amount);
        EncNote { id: note_id, enc_amount }
    }

    fn use_note(self: @User, note: UseNoteInput) -> Span<ServerAction> {
        self.compile_client_actions_revert(client_actions: [ClientAction::UseNote(note)].span())
    }

    fn internal_use_note(self: @User, note: UseNoteInput) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let mut token_balances: TokenBalances = Default::default();
                state.use_note(owner_addr: *self.address, input: note, ref :token_balances)
            },
        )
            .span()
    }

    fn compute_nullifier(
        self: @User, sender: User, token_address: ContractAddress, note_index: usize,
    ) -> felt252 {
        compute_nullifier(
            channel_key: sender.compute_channel_key(recipient: *self),
            token: token_address,
            index: note_index,
            owner_private_key: *self.private_key,
        )
    }

    fn new_note(
        self: @User,
        recipient: User,
        token_address: ContractAddress,
        amount: u128,
        index: usize,
        random: u128,
    ) -> CreateNoteInput {
        CreateNoteInput {
            sender_private_key: *self.private_key,
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            token: token_address,
            amount,
            index,
            random,
        }
    }

    fn new_note_with_generated_random(
        ref self: User, recipient: User, token_address: ContractAddress, amount: u128, index: usize,
    ) -> CreateNoteInput {
        let random = self.get_random();
        self.new_note(:recipient, :token_address, :amount, :index, :random)
    }

    fn deposit(self: @User, token: Token, amount: u128) -> Span<ServerAction> {
        let input = DepositInput { token: token.contract_address(), amount };
        self.compile_client_actions_revert([ClientAction::Deposit(input),].span())
    }

    fn internal_deposit(
        self: @User, token_address: ContractAddress, amount: u128,
    ) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let mut token_balances: TokenBalances = Default::default();
                let input = DepositInput { token: token_address, amount };
                state.deposit(user_addr: *self.address, :input, ref :token_balances)
            },
        )
            .span()
    }

    #[feature("safe_dispatcher")]
    fn safe_deposit(
        self: @User, token_address: ContractAddress, amount: u128,
    ) -> Result<(), Array<felt252>> {
        let input = DepositInput { token: token_address, amount };
        self.safe_compile_client_actions(client_actions: [ClientAction::Deposit(input),].span())
    }

    fn get_num_of_channels(self: @User) -> u64 {
        self
            .privacy
            .views
            .get_num_of_channels(
                recipient_addr: *self.address, recipient_public_key: *self.public_key,
            )
    }

    fn get_channel_info(self: @User, channel_index: u64) -> EncChannelInfo {
        self
            .privacy
            .views
            .get_channel_info(
                recipient_addr: *self.address,
                recipient_public_key: *self.public_key,
                :channel_index,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_get_channel_info(
        self: @User, channel_index: u64,
    ) -> Result<EncChannelInfo, Array<felt252>> {
        self
            .privacy
            .safe_views
            .get_channel_info(
                recipient_addr: *self.address,
                recipient_public_key: *self.public_key,
                :channel_index,
            )
    }

    fn set_viewing_key(self: @User, random: felt252) -> Span<ServerAction> {
        let input = SetViewingKeyInput { private_key: *self.private_key, random };
        self
            .compile_client_actions_revert(
                client_actions: [ClientAction::SetViewingKey(input)].span(),
            )
    }

    fn internal_set_viewing_key(self: @User, random: felt252) -> Span<ServerAction> {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                let input = SetViewingKeyInput { private_key: *self.private_key, random };
                state.set_viewing_key(user_addr: *self.address, :input)
            },
        )
            .span()
    }

    /// Returns (random, output) where output is the output of `set_viewing_key`.
    fn internal_set_viewing_key_with_generated_random(
        ref self: User,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random().into();
        let actions = self.internal_set_viewing_key(:random);
        (random, actions)
    }

    /// Returns the random value generated by the user for `set_viewing_key`.
    fn set_viewing_key_e2e(ref self: User) -> felt252 {
        let random = self.get_random().into();
        self.set_viewing_key_e2e_with_random(:random);
        random
    }

    fn set_viewing_key_e2e_with_random(ref self: User, random: felt252) {
        let actions = self.set_viewing_key(:random);
        self.privacy.server.execute_actions(:actions);
    }

    #[feature("safe_dispatcher")]
    fn safe_set_viewing_key(self: @User, random: felt252) -> Result<(), Array<felt252>> {
        let input = SetViewingKeyInput { private_key: *self.private_key, random };
        self
            .safe_compile_client_actions(
                client_actions: [ClientAction::SetViewingKey(input)].span(),
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
            compliance_public_key: self.privacy.get_compliance_public_key(),
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
        let token_addr = token.contract_address();
        cheat_caller_address_once(contract_address: token_addr, caller_address: *self.address);
        IERC20Dispatcher { contract_address: token_addr }
            .approve(spender: *self.privacy.address, :amount);
    }

    /// Cheat deposit in the server side (no client side).
    fn cheat_deposit(self: @User, token: Token, amount: u128, note: EncNote) {
        self.approve(:token, amount: amount.into());
        let actions = [
            ServerAction::WriteIfZero(
                WriteIfZeroInput {
                    storage_address: map_entry_address(
                        map_selector: selector!("notes"), keys: [note.id].span(),
                    ),
                    value: note.enc_amount,
                },
            ),
            ServerAction::TransferFrom(
                TransferFromInput {
                    sender_addr: *self.address, token: token.contract_address(), amount,
                },
            ),
        ]
            .span();
        self.privacy.server.execute_actions(:actions);
    }

    /// Cheat withdraw in the server side (no client side).
    fn cheat_withdraw(
        self: @User,
        recipient_addr: ContractAddress,
        token: Token,
        amount: u128,
        nullifier: felt252,
    ) {
        let actions = [
            ServerAction::WriteIfZero(
                WriteIfZeroInput {
                    storage_address: map_entry_address(
                        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
                    ),
                    value: true.into(),
                },
            ),
            ServerAction::TransferTo(
                TransferToInput { recipient_addr, token: token.contract_address(), amount },
            ),
        ]
            .span();
        self.privacy.server.execute_actions(:actions);
    }

    fn increase_token_balance(self: @User, token: Token, amount: u128) {
        token.supply(address: *self.address, :amount);
    }
}

#[derive(Drop, Copy)]
pub(crate) struct Test {
    pub privacy: PrivacyCfg,
    pub mock_client: MockClientCfg,
    pub nonce: usize,
    // TODO: Compliance fields as struct + trait?
    pub compliance_private_key: felt252,
    pub compliance_public_key: felt252,
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_user(ref self: Test) -> User {
        self.nonce += 1;
        let mut private_key = 'PRIVATE_KEY' + self.nonce.into();
        if !is_canonical_key(key: private_key) {
            private_key = Neg::neg(private_key);
        }
        let public_key = derive_public_key(:private_key);
        self.nonce += 1;
        let address = deploy_mock_account(salt: self.nonce.into());
        User {
            address,
            privacy: self.privacy,
            mock_client: self.mock_client,
            private_key,
            public_key,
            nonce: Zero::zero(),
        }
    }

    /// Mock function to generate a new token address.
    fn mock_new_token(ref self: Test) -> ContractAddress {
        self.nonce += 1;
        ('TOKEN_ADDRESS' + self.nonce.into()).try_into().unwrap()
    }

    /// Mock function to generate a new compliance private key.
    fn mock_new_enc_private_key(ref self: Test) -> EncPrivateKey {
        self.nonce += 1;
        EncPrivateKey {
            ephemeral_pubkey: 'EPHEMERAL_PUBKEY' + self.nonce.into(),
            enc_private_key: 'ENC_PRIVATE_KEY' + self.nonce.into(),
        }
    }

    /// Mock function to generate a new note.
    /// Returns (enc_channel_info, channel_id).
    fn mock_new_channel(ref self: Test) -> (EncChannelInfo, felt252) {
        self.nonce += 1;
        let enc_channel_info = EncChannelInfo {
            ephemeral_pubkey: 'EPHEMERAL_PUBKEY' + self.nonce.into(),
            enc_channel_key: 'ENC_CHANNEL_KEY' + self.nonce.into(),
            enc_sender_addr: 'ENC_SENDER_ADDR' + self.nonce.into(),
        };
        let channel_id = 'CHANNEL_ID' + self.nonce.into();
        (enc_channel_info, channel_id)
    }

    /// Mock function to generate a new subchannel.
    /// Returns (subchannel_id, subchannel_key, enc_subchannel_info).
    fn mock_new_subchannel(ref self: Test) -> (felt252, felt252, EncSubchannelInfo) {
        self.nonce += 1;
        let subchannel_id = 'SUBCHANNEL_ID' + self.nonce.into();
        let subchannel_key = 'SUBCHANNEL_KEY' + self.nonce.into();
        let enc_subchannel_info = EncSubchannelInfo {
            random: 'RANDOM' + self.nonce.into(), enc_token: 'ENC_TOKEN' + self.nonce.into(),
        };
        (subchannel_id, subchannel_key, enc_subchannel_info)
    }

    /// Mock function to generate a new note.
    fn mock_new_note(ref self: Test, amount: u128) -> EncNote {
        self.nonce += 1;
        let id = 'NOTE_ID' + self.nonce.into();
        let enc_amount = 'ENC_AMOUNT' + amount.into() + self.nonce.into();
        EncNote { id, enc_amount }
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

    /// Asserts the message from the spy is valid.
    fn general_assert_spy_messages(ref self: Test, ref spy: MessageToL1Spy) {
        assert_eq!(spy.get_messages().messages.len(), 1);
        let (from, message) = spy.get_messages().messages.at(0);
        assert_eq!(*from, self.privacy.address);
        assert_eq!(*message.to_address, Zero::zero());
    }
}

// TODO: Move to utils repo.
#[generate_trait]
pub(crate) impl PrivacyTokenImpl of PrivacyTokenTrait {
    fn balance_of(self: @Token, address: ContractAddress) -> u256 {
        IERC20Dispatcher { contract_address: self.contract_address() }.balance_of(account: address)
    }

    fn supply(self: @Token, address: ContractAddress, amount: u128) {
        let current_balance = self.balance_of(:address);
        set_balance(target: address, new_balance: current_balance + amount.into(), token: *self);
    }
}

#[generate_trait]
pub(crate) impl PrivacyCfgImpl of PrivacyCfgTrait {
    /// Cheat open a channel in the server side (no client side).
    fn cheat_open_channel(
        self: @PrivacyCfg,
        recipient_addr: ContractAddress,
        recipient_public_key: felt252,
        enc_channel_info: EncChannelInfo,
        channel_id: felt252,
    ) {
        let actions = [
            ServerAction::WriteIfZero(
                WriteIfZeroInput {
                    storage_address: map_entry_address(
                        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
                    ),
                    value: true.into(),
                },
            ),
            ServerAction::AppendToVec(
                AppendToVecInput { recipient_addr, recipient_public_key, enc_channel_info },
            ),
        ]
            .span();
        self.execute_actions(:actions);
    }

    fn channel_exists(self: @PrivacyCfg, channel_id: felt252) -> bool {
        self.views.channel_exists(:channel_id)
    }

    fn subchannel_exists(self: @PrivacyCfg, subchannel_id: felt252) -> bool {
        self.views.subchannel_exists(:subchannel_id)
    }

    fn get_subchannel_info(self: @PrivacyCfg, subchannel_key: felt252) -> EncSubchannelInfo {
        self.views.get_subchannel_info(:subchannel_key)
    }

    /// Cheat create a note in the server side (no client side).
    fn cheat_create_note(self: @PrivacyCfg, note: EncNote) {
        let storage_path_felt = map_entry_address(
            map_selector: selector!("notes"), keys: [note.id].span(),
        );
        self
            .server
            .execute_actions(
                actions: array![
                    ServerAction::WriteIfZero(
                        WriteIfZeroInput {
                            storage_address: storage_path_felt, value: note.enc_amount,
                        },
                    ),
                ]
                    .span(),
            )
    }

    fn get_note(self: @PrivacyCfg, note_id: felt252) -> felt252 {
        self.views.get_note(:note_id)
    }

    /// Cheat use a note in the server side (no client side).
    fn cheat_use_note(self: @PrivacyCfg, nullifier: felt252) {
        let storage_path_felt = map_entry_address(
            map_selector: selector!("nullifiers"), keys: [nullifier].span(),
        );
        self
            .server
            .execute_actions(
                actions: array![
                    ServerAction::WriteIfZero(
                        WriteIfZeroInput { storage_address: storage_path_felt, value: true.into() },
                    ),
                ]
                    .span(),
            )
    }

    fn nullifier_exists(self: @PrivacyCfg, nullifier: felt252) -> bool {
        self.views.nullifier_exists(:nullifier)
    }

    fn get_compliance_public_key(self: @PrivacyCfg) -> felt252 {
        self.views.get_compliance_public_key()
    }

    fn execute_actions(self: @PrivacyCfg, actions: Span<ServerAction>) {
        self.server.execute_actions(:actions);
    }

    #[feature("safe_dispatcher")]
    fn safe_execute_actions(
        self: @PrivacyCfg, actions: Span<ServerAction>,
    ) -> Result<(), Array<felt252>> {
        self.safe_server.execute_actions(:actions)
    }

    fn pause(self: @PrivacyCfg) {
        cheat_caller_address_once(
            contract_address: *self.address, caller_address: *self.governance_admin,
        );
        IPausableDispatcher { contract_address: *self.address }.pause();
    }

    fn store_zero(self: @PrivacyCfg, storage_address: felt252) {
        store(target: *self.address, :storage_address, serialized_value: [Zero::zero()].span());
    }

    fn pop_from_vec(
        self: @PrivacyCfg, recipient_addr: ContractAddress, recipient_public_key: felt252,
    ) {
        let target = *self.address;
        let vector_storage_address = map_entry_address(
            map_selector: selector!("recipient_channels"),
            keys: [recipient_addr.into(), recipient_public_key].span(),
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

    fn increase_token_balance(self: @PrivacyCfg, token: Token, amount: u128) {
        token.supply(address: *self.address, :amount);
    }

    fn execute(self: @PrivacyCfg, user_addr: ContractAddress, client_actions: Span<ClientAction>) {
        cheat_caller_address_once(contract_address: *self.address, caller_address: Zero::zero());
        self.client.__execute__(:user_addr, :client_actions)
    }

    #[feature("safe_dispatcher")]
    fn safe_execute(
        self: @PrivacyCfg, user_addr: ContractAddress, client_actions: Span<ClientAction>,
    ) -> Result<(), Array<felt252>> {
        cheat_caller_address_once(contract_address: *self.address, caller_address: Zero::zero());
        self.safe_client.__execute__(:user_addr, :client_actions)
    }

    fn validate(
        self: @PrivacyCfg, user_addr: ContractAddress, client_actions: Span<ClientAction>,
    ) -> felt252 {
        self.client.__validate__(:user_addr, :client_actions)
    }
}

#[derive(Drop, Copy)]
struct MockClientCfg {
    pub address: ContractAddress,
    pub privacy: ContractAddress,
}

#[generate_trait]
impl MockClientImpl of MockClientTrait {
    #[feature("safe_dispatcher")]
    fn execute(
        self: @MockClientCfg, user_addr: ContractAddress, client_actions: Span<ClientAction>,
    ) -> Span<ServerAction> {
        cheat_caller_address_once(contract_address: *self.privacy, caller_address: Zero::zero());
        let mut spy = spy_messages_to_l1();
        IMockClientDispatcher { contract_address: *self.address }
            .wrap_execute(:user_addr, :client_actions);

        // Assert the message from the spy is valid.
        assert_eq!(spy.get_messages().messages.len(), 1);
        let (from, message) = spy.get_messages().messages.at(0);
        assert_eq!(*from, *self.privacy);
        assert_eq!(*message.to_address, Zero::zero());

        // Return the server actions.
        spy_messages_to_server_actions(ref :spy)
    }
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let governance_admin = 'GOVERNANCE_ADMIN'.try_into().unwrap();
        let compliance_private_key = 'COMPLIANCE_PRIVATE_KEY';
        let compliance_public_key = derive_public_key(private_key: compliance_private_key);
        let privacy = deploy_privacy(:governance_admin, :compliance_public_key);
        let mock_client = deploy_mock_client(client_contract: privacy.address);
        Test {
            privacy,
            mock_client,
            nonce: Zero::zero(),
            compliance_private_key,
            compliance_public_key,
        }
    }
}

fn deploy_mock_client(client_contract: ContractAddress) -> MockClientCfg {
    let contract_class_hash = declare(contract: "MockClient")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_client_for_test(
        class_hash: *contract_class_hash, :deployment_params, :client_contract,
    )
        .expect('Mock Client deployment failed');
    MockClientCfg { address: contract_address, privacy: client_contract }
}

pub(crate) fn deploy_privacy(
    governance_admin: ContractAddress, compliance_public_key: felt252,
) -> PrivacyCfg {
    let contract_class_hash = declare(contract: "Privacy")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_privacy_for_test(
        class_hash: *contract_class_hash,
        :deployment_params,
        :governance_admin,
        :compliance_public_key,
    )
        .expect('Privacy deployment failed');
    // TODO: Use different address for different roles?
    set_account_as_security_agent(
        contract: contract_address, account: governance_admin, security_admin: governance_admin,
    );
    PrivacyCfg {
        address: contract_address,
        governance_admin,
        server: IServerDispatcher { contract_address },
        safe_server: IServerSafeDispatcher { contract_address },
        client: IClientDispatcher { contract_address },
        safe_client: IClientSafeDispatcher { contract_address },
        views: IViewsDispatcher { contract_address },
        safe_views: IViewsSafeDispatcher { contract_address },
    }
}

pub(crate) fn deploy_mock_account(salt: felt252) -> ContractAddress {
    let contract_class_hash = declare(contract: "MockAccount")
        .unwrap_syscall()
        .contract_class()
        .class_hash;
    let deployment_params = DeploymentParams { salt, deploy_from_zero: true };
    let (contract_address, _) = deploy_mock_account_for_test(
        class_hash: *contract_class_hash, :deployment_params,
    )
        .expect('MockAccount deployment failed');
    contract_address
}

/// Returns private_key decrypted from the given `enc_private_key` and
/// compliance's `private_key`.
pub(crate) fn decrypt_private_key(
    enc_private_key: EncPrivateKey, compliance_private_key: felt252,
) -> felt252 {
    // Find shared point.
    let ephemeral_pubkey_point = EcPointTrait::new_from_x(x: enc_private_key.ephemeral_pubkey)
        .unwrap();
    let shared_point = ephemeral_pubkey_point.mul(scalar: compliance_private_key);
    let shared_x = shared_point.try_into().unwrap().x();

    // Decrypt private key.
    enc_private_key.enc_private_key - compute_enc_private_key_hash(:shared_x)
}

/// Returns (channel_key, sender_addr) decrypted from the given `enc_channel_info` and
/// recipient's `private_key`.
pub(crate) fn decrypt_channel_info(
    enc_channel_info: EncChannelInfo, private_key: felt252,
) -> (felt252, ContractAddress) {
    // Find shared point.
    let ephemeral_pubkey_point = EcPointTrait::new_from_x(x: enc_channel_info.ephemeral_pubkey)
        .unwrap();
    let shared_point = ephemeral_pubkey_point.mul(scalar: private_key);
    let shared_x = shared_point.try_into().unwrap().x();

    // Decrypt channel key.
    let decrypted_channel_key = enc_channel_info.enc_channel_key
        - compute_enc_channel_key_hash(:shared_x);

    // Decrypt sender address.
    let decrypted_sender_addr = enc_channel_info.enc_sender_addr
        - compute_enc_sender_addr_hash(:shared_x);

    (decrypted_channel_key, decrypted_sender_addr.try_into().unwrap())
}

pub(crate) fn decrypt_subchannel_token(
    enc_subchannel_info: EncSubchannelInfo, channel_key: felt252,
) -> ContractAddress {
    let token = enc_subchannel_info.enc_token
        - compute_enc_token_hash(:channel_key, random: enc_subchannel_info.random);
    token.try_into().unwrap()
}

fn deserialize_server_actions(message: @MessageToL1) -> Span<ServerAction> {
    let mut payload = message.payload.span();
    Serde::<Span<ServerAction>>::deserialize(ref payload).expect('Failed deserialize')
}

pub(crate) fn spy_messages_to_server_actions(ref spy: MessageToL1Spy) -> Span<ServerAction> {
    let (_from, message) = spy.get_messages().messages.at(0);
    deserialize_server_actions(:message)
}
