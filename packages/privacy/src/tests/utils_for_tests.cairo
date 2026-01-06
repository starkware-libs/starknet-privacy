use core::ec::EcPointTrait;
use core::num::traits::Zero;
use core::traits::Neg;
use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
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
    ClientAction, EncChannelInfo, EncPrivateKey, EncSubchannelInfo, NewNote, NotePath, ServerAction,
    TokenBalances,
};
use privacy::privacy::Privacy;
use privacy::privacy::Privacy::{ClientInternalTrait, deploy_for_test as deploy_privacy_for_test};
use privacy::utils::constants::TWO_POW_120;
use privacy::utils::{
    derive_public_key, encrypt_note_amount, encrypt_private_key, encrypt_subchannel_info,
    is_canonical_key,
};
use snforge_std::{
    CustomToken, DeclareResultTrait, Token, TokenTrait, declare, interact_with_state,
    map_entry_address, set_balance,
};
use starknet::ContractAddress;
use starknet::deployment::DeploymentParams;
use starknet::storage::StorableStoragePointerReadAccess;
use starkware_utils_testing::test_utils::{Deployable, TokenConfig, cheat_caller_address_once};

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
        [ServerAction::WriteIfZero((storage_path, *self.enc_amount)),].span()
    }
}

#[derive(Copy, Drop)]
pub(crate) struct PrivacyCfg {
    pub address: ContractAddress,
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
    pub private_key: felt252,
    pub public_key: felt252,
    nonce: usize,
}

#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn compile_client_actions(
        self: @User, client_actions: Span<ClientAction>,
    ) -> Span<ServerAction> {
        self.privacy.client.compile_client_actions(user_addr: *self.address, :client_actions)
    }

    #[feature("safe_dispatcher")]
    fn safe_compile_client_actions(
        self: @User, client_actions: Span<ClientAction>,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self.privacy.safe_client.compile_client_actions(user_addr: *self.address, :client_actions)
    }

    fn transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> Span<ServerAction> {
        let mut client_actions: Array<ClientAction> = array![];
        for note in notes_to_use {
            client_actions.append(ClientAction::UseNote((*self.private_key, *note)));
        }
        for note in notes_to_create {
            client_actions.append(ClientAction::CreateNote((*self.private_key, *note)));
        }

        self.compile_client_actions(client_actions: client_actions.span())
    }

    #[feature("safe_dispatcher")]
    fn safe_transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        let mut client_actions: Array<ClientAction> = array![];
        for note in notes_to_use {
            client_actions.append(ClientAction::UseNote((*self.private_key, *note)));
        }
        for note in notes_to_create {
            client_actions.append(ClientAction::CreateNote((*self.private_key, *note)));
        }

        self.safe_compile_client_actions(client_actions: client_actions.span())
    }

    fn withdraw(
        self: @User, withdrawal_target: ContractAddress, token: ContractAddress, amount: u128,
    ) -> Span<ServerAction> {
        self
            .compile_client_actions(
                client_actions: [ClientAction::Withdraw((withdrawal_target, token, amount))].span(),
            )
    }

    fn internal_withdraw(
        self: @User, withdrawal_target: ContractAddress, token: ContractAddress, amount: u128,
    ) -> Span<ServerAction> {
        [
            interact_with_state(
                *self.privacy.address,
                || {
                    let mut state = Privacy::contract_state_for_testing();
                    let mut token_balances: TokenBalances = Default::default();
                    state.withdraw(:withdrawal_target, :token, :amount, ref :token_balances)
                },
            )
        ]
            .span()
    }

    #[feature("safe_dispatcher")]
    fn safe_withdraw(
        self: @User, withdrawal_target: ContractAddress, token: ContractAddress, amount: u128,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .safe_compile_client_actions(
                client_actions: [ClientAction::Withdraw((withdrawal_target, token, amount))].span(),
            )
    }

    fn open_channel(self: @User, recipient: User, random: felt252) -> Span<ServerAction> {
        self
            .compile_client_actions(
                client_actions: [
                    ClientAction::OpenChannel(
                        (*self.private_key, recipient.address, recipient.public_key, random),
                    )
                ]
                    .span(),
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel(
        self: @User, recipient: User, random: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .safe_compile_client_actions(
                client_actions: [
                    ClientAction::OpenChannel(
                        (*self.private_key, recipient.address, recipient.public_key, random),
                    )
                ]
                    .span(),
            )
    }

    /// Returns (random, output) where output is the output of `open_channel`.
    fn open_channel_with_generated_random(
        ref self: User, recipient: User,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random().into();
        let output = self.open_channel(:recipient, :random);
        (random, output)
    }

    /// Returns the random value generated by the user for the channel opening.
    fn open_channel_e2e(ref self: User, recipient: User) -> felt252 {
        let (random, actions) = self.open_channel_with_generated_random(:recipient);
        self.privacy.server.execute_actions(:actions);
        random
    }

    fn open_subchannel(
        self: @User, recipient: User, token: ContractAddress, index: usize, random: felt252,
    ) -> Span<ServerAction> {
        let channel_key = self.compute_channel_key(:recipient);
        self
            .compile_client_actions(
                client_actions: [
                    ClientAction::OpenSubchannel(
                        (
                            recipient.address,
                            recipient.public_key,
                            channel_key,
                            index,
                            token,
                            random,
                        ),
                    ),
                ]
                    .span(),
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_open_subchannel(
        self: @User, recipient: User, token: ContractAddress, index: usize, random: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        let channel_key = self.compute_channel_key(:recipient);
        self
            .safe_compile_client_actions(
                client_actions: [
                    ClientAction::OpenSubchannel(
                        (
                            recipient.address,
                            recipient.public_key,
                            channel_key,
                            index,
                            token,
                            random,
                        ),
                    ),
                ]
                    .span(),
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_open_subchannel_with_channel_key(
        self: @User,
        recipient: User,
        token: ContractAddress,
        index: usize,
        random: felt252,
        channel_key: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .safe_compile_client_actions(
                client_actions: [
                    ClientAction::OpenSubchannel(
                        (
                            recipient.address,
                            recipient.public_key,
                            channel_key,
                            index,
                            token,
                            random,
                        ),
                    ),
                ]
                    .span(),
            )
    }

    /// Returns (random, output) where output is the output of `open_subchannel`.
    fn open_subchannel_with_generated_random(
        ref self: User, recipient: User, token: ContractAddress, index: usize,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random().into();
        let output = self.open_subchannel(:recipient, :token, :index, :random);
        (random, output)
    }

    /// Returns the random value generated by the user for the subchannel opening.
    fn open_subchannel_e2e(
        ref self: User, recipient: User, token: ContractAddress, index: usize,
    ) -> felt252 {
        let (random, actions) = self
            .open_subchannel_with_generated_random(:recipient, :token, :index);
        self.privacy.server.execute_actions(:actions);
        random
    }

    /// Open a channel and a subchannel with the given token.
    /// Returns (random_generated_for_channel, random_generated_for_subchannel).
    fn open_channel_with_token_e2e(
        ref self: User, recipient: User, token: ContractAddress, subchannel_index: usize,
    ) -> (felt252, felt252) {
        let random_channel = self.open_channel_e2e(:recipient);
        let random_subchannel = self
            .open_subchannel_e2e(:recipient, :token, index: subchannel_index);
        (random_channel, random_subchannel)
    }

    /// Returns a random value of 120 bits.
    fn get_random(ref self: User) -> u128 {
        self.nonce += 1;
        let hash_u256: u256 = hash(['RANDOM', self.nonce.into()].span()).into();
        (hash_u256 % TWO_POW_120.into()).try_into().expect('RANDOM_OVERFLOW')
    }

    fn create_note(self: @User, note: NewNote) -> Span<ServerAction> {
        self.compile_client_actions([ClientAction::CreateNote((*self.private_key, note)),].span())
    }

    fn internal_create_note(self: @User, note: NewNote) -> Span<ServerAction> {
        [
            interact_with_state(
                *self.privacy.address,
                || {
                    let mut state = Privacy::contract_state_for_testing();
                    let mut token_balances: TokenBalances = Default::default();
                    state
                        .create_note(
                            owner_addr: *self.address,
                            owner_private_key: *self.private_key,
                            :note,
                            ref :token_balances,
                        )
                },
            )
        ]
            .span()
    }

    fn cheat_create_note_e2e(self: @User, note: NewNote) {
        self.privacy.server.execute_actions(actions: self.internal_create_note(:note));
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

    fn compute_subchannel_id(self: @User, recipient: User, token: ContractAddress) -> felt252 {
        compute_subchannel_id(
            channel_key: self.compute_channel_key(:recipient),
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            :token,
        )
    }

    fn compute_enc_subchannel_info(
        self: @User, recipient: User, token: ContractAddress, random: felt252,
    ) -> EncSubchannelInfo {
        let channel_key = self.compute_channel_key(:recipient);
        encrypt_subchannel_info(:channel_key, :token, :random)
    }

    fn compute_enc_note(
        self: @User,
        recipient: User,
        token: ContractAddress,
        index: usize,
        amount: u128,
        random: u128,
    ) -> EncNote {
        let channel_key = self.compute_channel_key(:recipient);
        let note_id = compute_note_id(:channel_key, :token, :index);
        let enc_amount = encrypt_note_amount(:channel_key, :random, :amount);
        EncNote { id: note_id, enc_amount }
    }

    fn use_note(self: @User, note: NotePath) -> Span<ServerAction> {
        self
            .compile_client_actions(
                client_actions: [ClientAction::UseNote((*self.private_key, note))].span(),
            )
    }

    fn internal_use_note(self: @User, note: NotePath) -> Span<ServerAction> {
        [
            interact_with_state(
                *self.privacy.address,
                || {
                    let mut state = Privacy::contract_state_for_testing();
                    let mut token_balances: TokenBalances = Default::default();
                    state
                        .use_note(
                            owner_addr: *self.address,
                            owner_private_key: *self.private_key,
                            :note,
                            ref :token_balances,
                        )
                },
            )
        ]
            .span()
    }

    fn compute_nullifier(
        self: @User, sender: User, token: ContractAddress, note_index: usize,
    ) -> felt252 {
        compute_nullifier(
            channel_key: sender.compute_channel_key(recipient: *self),
            :token,
            index: note_index,
            owner_private_key: *self.private_key,
        )
    }

    fn new_note(
        self: @User,
        recipient: User,
        token: ContractAddress,
        amount: u128,
        index: usize,
        random: u128,
    ) -> NewNote {
        NewNote {
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            token,
            amount,
            index,
            random,
        }
    }

    fn new_note_with_generated_random(
        ref self: User, recipient: User, token: ContractAddress, amount: u128, index: usize,
    ) -> NewNote {
        let random = self.get_random();
        self.new_note(:recipient, :token, :amount, :index, :random)
    }

    fn deposit(self: @User, token: ContractAddress, amount: u128) -> Span<ServerAction> {
        self.compile_client_actions([ClientAction::Deposit((token, amount)),].span())
    }

    fn internal_deposit(self: @User, token: ContractAddress, amount: u128) -> Span<ServerAction> {
        [
            interact_with_state(
                *self.privacy.address,
                || {
                    let mut state = Privacy::contract_state_for_testing();
                    let mut token_balances: TokenBalances = Default::default();
                    state.deposit(user_addr: *self.address, :token, :amount, ref :token_balances)
                },
            )
        ]
            .span()
    }

    #[feature("safe_dispatcher")]
    fn safe_deposit(
        self: @User, token: ContractAddress, amount: u128,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .safe_compile_client_actions(
                client_actions: [ClientAction::Deposit((token, amount)),].span(),
            )
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
        self
            .compile_client_actions(
                client_actions: [ClientAction::SetViewingKey((*self.private_key, random))].span(),
            )
    }

    /// Returns (random, output) where output is the output of `set_viewing_key`.
    fn set_viewing_key_with_generated_random(ref self: User) -> (felt252, Span<ServerAction>) {
        let random = self.get_random().into();
        let actions = self.set_viewing_key(:random);
        (random, actions)
    }

    /// Returns the random value generated by the user for `set_viewing_key`.
    fn set_viewing_key_e2e(ref self: User) -> felt252 {
        let (random, actions) = self.set_viewing_key_with_generated_random();
        self.privacy.server.execute_actions(:actions);
        random
    }

    #[feature("safe_dispatcher")]
    fn safe_set_viewing_key(
        self: @User, random: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .safe_compile_client_actions(
                client_actions: [ClientAction::SetViewingKey((*self.private_key, random))].span(),
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
                (
                    map_entry_address(map_selector: selector!("notes"), keys: [note.id].span()),
                    note.enc_amount,
                ),
            ),
            ServerAction::TransferFrom((*self.address, token.contract_address(), amount)),
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
                (
                    map_entry_address(
                        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
                    ),
                    true.into(),
                ),
            ),
            ServerAction::TransferTo((recipient_addr, token.contract_address(), amount)),
        ]
            .span();
        self.privacy.server.execute_actions(:actions);
    }
}

#[derive(Drop, Copy)]
pub(crate) struct Test {
    pub privacy: PrivacyCfg,
    pub nonce: usize,
    // TODO: Compliance fields as struct + trait?
    pub compliance_private_key: felt252,
    pub compliance_public_key: felt252,
}

#[generate_trait]
pub(crate) impl TestImpl of TestTrait {
    fn new_user(ref self: Test) -> User {
        self.nonce += 1;
        let mut private_key = ('PRIVATE_KEY' + self.nonce.into()).try_into().unwrap();
        if !is_canonical_key(key: private_key) {
            private_key = Neg::neg(private_key);
        }
        let public_key = derive_public_key(:private_key);
        User {
            address: ('USER_ADDRESS' + self.nonce.into()).try_into().unwrap(),
            privacy: self.privacy,
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
            ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + self.nonce.into()).try_into().unwrap(),
            enc_private_key: ('ENC_PRIVATE_KEY' + self.nonce.into()).try_into().unwrap(),
        }
    }

    /// Mock function to generate a new note.
    /// Returns (enc_channel_info, channel_id).
    fn mock_new_channel(ref self: Test) -> (EncChannelInfo, felt252) {
        self.nonce += 1;
        let enc_channel_info = EncChannelInfo {
            ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + self.nonce.into()).try_into().unwrap(),
            enc_channel_key: ('ENC_CHANNEL_KEY' + self.nonce.into()).try_into().unwrap(),
            enc_sender_addr: ('ENC_SENDER_ADDR' + self.nonce.into()).try_into().unwrap(),
        };
        let channel_id = ('CHANNEL_ID' + self.nonce.into()).try_into().unwrap();
        (enc_channel_info, channel_id)
    }

    /// Mock function to generate a new subchannel.
    /// Returns (subchannel_id, subchannel_key, enc_subchannel_info).
    fn mock_new_subchannel(ref self: Test) -> (felt252, felt252, EncSubchannelInfo) {
        self.nonce += 1;
        let subchannel_id = ('SUBCHANNEL_ID' + self.nonce.into()).try_into().unwrap();
        let subchannel_key = ('SUBCHANNEL_KEY' + self.nonce.into()).try_into().unwrap();
        let enc_subchannel_info = EncSubchannelInfo {
            random: ('RANDOM' + self.nonce.into()).try_into().unwrap(),
            enc_token: ('ENC_TOKEN' + self.nonce.into()).try_into().unwrap(),
        };
        (subchannel_id, subchannel_key, enc_subchannel_info)
    }

    /// Mock function to generate a new note.
    fn mock_new_note(ref self: Test, amount: u128) -> EncNote {
        self.nonce += 1;
        let id = ('NOTE_ID' + self.nonce.into()).try_into().unwrap();
        let enc_amount = ('ENC_AMOUNT' + amount.into() + self.nonce.into()).try_into().unwrap();
        EncNote { id, enc_amount }
    }

    /// Mock function to generate a new nullifier.
    fn mock_new_nullifier(ref self: Test) -> felt252 {
        self.nonce += 1;
        ('NULLIFIER' + self.nonce.into()).try_into().unwrap()
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
}

// TODO: Move to utils repo.
#[generate_trait]
pub(crate) impl PrivacyTokenImpl of PrivacyTokenTrait {
    fn balance_of(self: @Token, address: ContractAddress) -> u256 {
        IERC20Dispatcher { contract_address: self.contract_address() }.balance_of(account: address)
    }

    fn supply(self: @Token, user: User, amount: u128) {
        let current_balance = self.balance_of(user.address);
        set_balance(
            target: user.address, new_balance: current_balance + amount.into(), token: *self,
        );
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
                (
                    map_entry_address(
                        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
                    ),
                    true.into(),
                ),
            ),
            ServerAction::AppendToVec((recipient_addr, recipient_public_key, enc_channel_info)),
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
                actions: array![ServerAction::WriteIfZero((storage_path_felt, note.enc_amount))]
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
                actions: array![ServerAction::WriteIfZero((storage_path_felt, true.into()))].span(),
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
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let compliance_private_key = 'COMPLIANCE_PRIVATE_KEY';
        let compliance_public_key = derive_public_key(private_key: compliance_private_key);
        let privacy = deploy_privacy(:compliance_public_key);
        Test { privacy, nonce: Zero::zero(), compliance_private_key, compliance_public_key }
    }
}

pub(crate) fn deploy_privacy(compliance_public_key: felt252) -> PrivacyCfg {
    let contract_class_hash = declare(contract: "Privacy").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_privacy_for_test(
        class_hash: *contract_class_hash, :deployment_params, :compliance_public_key,
    )
        .expect('Privacy deployment failed');
    PrivacyCfg {
        address: contract_address,
        server: IServerDispatcher { contract_address },
        safe_server: IServerSafeDispatcher { contract_address },
        client: IClientDispatcher { contract_address },
        safe_client: IClientSafeDispatcher { contract_address },
        views: IViewsDispatcher { contract_address },
        safe_views: IViewsSafeDispatcher { contract_address },
    }
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
