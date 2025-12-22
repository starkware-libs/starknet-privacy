use client::client::Client;
use client::client::Client::deploy_for_test as deploy_client_for_test;
use client::interface::{
    IClientDispatcher, IClientDispatcherTrait, IClientSafeDispatcher, IClientSafeDispatcherTrait,
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
};
use client::objects::{EncChannelInfo, EncNote, NewNote, NotePath};
use client::utils::{
    compute_channel_key, compute_enc_channel_key_hash, compute_enc_sender_addr_hash,
    compute_enc_token_hash, compute_note_id, compute_nullifier, derive_public_key,
    encrypt_note_amount, hash, is_canonical_key,
};
use core::ec::EcPointTrait;
use core::num::traits::Zero;
use core::traits::Neg;
use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use snforge_std::{
    CustomToken, DeclareResultTrait, Token, TokenTrait, declare, interact_with_state, set_balance,
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

#[derive(Copy, Drop)]
pub(crate) struct ClientCfg {
    pub address: ContractAddress,
}

pub(crate) fn deploy_client() -> ClientCfg {
    let contract_class_hash = declare(contract: "Client").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    // Server address parameter is ignored - constructor sets it to self
    let server: ContractAddress = 1.try_into().unwrap();
    let (contract_address, _) = deploy_client_for_test(
        class_hash: *contract_class_hash, :deployment_params, server: server,
    )
        .expect('Client deployment failed');
    ClientCfg { address: contract_address }
}

#[derive(Copy, Drop)]
struct User {
    pub address: ContractAddress,
    pub client: ContractAddress,
    pub private_key: felt252,
    pub public_key: felt252,
    nonce: usize,
}

// TODO: Consider renaming fn_name_server to server_fn_name.
#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    // Client functions
    fn transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> (Span<felt252>, Span<EncNote>) {
        IClientDispatcher { contract_address: *self.client }
            .prepare_transfer(
                owner_addr: *self.address,
                owner_private_key: *self.private_key,
                :notes_to_use,
                :notes_to_create,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> Result<(Span<felt252>, Span<EncNote>), Array<felt252>> {
        IClientSafeDispatcher { contract_address: *self.client }
            .prepare_transfer(
                owner_addr: *self.address,
                owner_private_key: *self.private_key,
                :notes_to_use,
                :notes_to_create,
            )
    }

    fn withdraw(
        self: @User, withdrawal_target: ContractAddress, note_to_withdraw: NotePath,
    ) -> (ContractAddress, ContractAddress, u128, felt252) {
        IClientDispatcher { contract_address: *self.client }
            .prepare_withdraw(
                owner_addr: *self.address,
                owner_private_key: *self.private_key,
                :withdrawal_target,
                :note_to_withdraw,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_withdraw(
        self: @User, withdrawal_target: ContractAddress, note_to_withdraw: NotePath,
    ) -> Result<(ContractAddress, ContractAddress, u128, felt252), Array<felt252>> {
        IClientSafeDispatcher { contract_address: *self.client }
            .prepare_withdraw(
                owner_addr: *self.address,
                owner_private_key: *self.private_key,
                :withdrawal_target,
                :note_to_withdraw,
            )
    }

    fn open_channel(
        self: @User, recipient: User, token: ContractAddress, random: felt252,
    ) -> (ContractAddress, EncChannelInfo, felt252) {
        IClientDispatcher { contract_address: *self.client }
            .prepare_open_channel(
                sender_addr: *self.address,
                sender_private_key: *self.private_key,
                recipient_addr: recipient.address,
                :token,
                :random,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel(
        self: @User, recipient: User, token: ContractAddress, random: felt252,
    ) -> Result<(ContractAddress, EncChannelInfo, felt252), Array<felt252>> {
        IClientSafeDispatcher { contract_address: *self.client }
            .prepare_open_channel(
                sender_addr: *self.address,
                sender_private_key: *self.private_key,
                recipient_addr: recipient.address,
                :token,
                :random,
            )
    }

    /// Returns (random, output) where output is the output of `open_channel`.
    fn open_channel_with_generated_random(
        ref self: User, recipient: User, token: ContractAddress,
    ) -> (felt252, (ContractAddress, EncChannelInfo, felt252)) {
        let random = self.get_random();
        let output = self.open_channel(:recipient, :token, :random);
        (random, output)
    }

    fn _open_channel_server(
        self: @User,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannelInfo,
        channel_id: felt252,
    ) {
        IServerDispatcher { contract_address: *self.client }
            .open_channel(:recipient_addr, :enc_channel_info, :channel_id)
    }

    fn open_channel_e2e(ref self: User, recipient: User, token: ContractAddress) {
        let (_, channel_output) = self
            .open_channel_with_generated_random(recipient: recipient, :token);
        let (recipient_addr, enc_channel_info, channel_id) = channel_output;
        self._open_channel_server(:recipient_addr, :enc_channel_info, :channel_id)
    }

    fn register_server(self: @User) {
        cheat_caller_address_once(contract_address: *self.client, caller_address: *self.address);
        IServerDispatcher { contract_address: *self.client }.register(public_key: *self.public_key)
    }

    fn get_num_of_channels_server(self: @User) -> u64 {
        IServerDispatcher { contract_address: *self.client }
            .get_num_of_channels(recipient_addr: *self.address)
    }

    fn get_enc_channel_info_server(self: @User, channel_index: u64) -> EncChannelInfo {
        IServerDispatcher { contract_address: *self.client }
            .get_channel_info(recipient_addr: *self.address, :channel_index)
    }

    fn get_random(ref self: User) -> felt252 {
        self.nonce += 1;
        hash(['RANDOM', self.nonce.into()].span())
    }

    fn create_note(self: @User, note: NewNote) -> EncNote {
        interact_with_state(
            *self.client,
            || {
                let mut state = Client::contract_state_for_testing();
                Client::ClientInternalTrait::create_note(
                    @state,
                    owner_addr: *self.address,
                    owner_private_key: *self.private_key,
                    :note,
                    server: IServerDispatcher { contract_address: *self.client },
                )
            },
        )
    }

    fn create_note_server(self: @User, note: EncNote) {
        interact_with_state(
            *self.client,
            || {
                let mut state = Client::contract_state_for_testing();
                Client::ServerInternalTrait::create_note(ref state, :note)
            },
        )
    }

    fn create_note_e2e(self: @User, note: NewNote) {
        let enc_note = self.create_note(:note);
        self.create_note_server(note: enc_note);
    }

    fn compute_channel_key(self: @User, recipient: User, token: ContractAddress) -> felt252 {
        compute_channel_key(
            sender_addr: *self.address,
            sender_private_key: *self.private_key,
            recipient_addr: recipient.address,
            recipient_public_key: recipient.public_key,
            :token,
        )
    }

    fn compute_enc_note(
        self: @User, recipient: User, token: ContractAddress, index: usize, amount: u128,
    ) -> EncNote {
        let channel_key = self.compute_channel_key(:recipient, :token);
        let note_id = compute_note_id(:channel_key, :index, public_key: recipient.public_key);
        let enc_amount = encrypt_note_amount(:channel_key, :index, :amount);
        EncNote { id: note_id, enc_amount }
    }

    fn use_note(self: @User, note: NotePath) -> (felt252, ContractAddress, u128) {
        interact_with_state(
            *self.client,
            || {
                let mut state = Client::contract_state_for_testing();
                Client::ClientInternalTrait::use_note(
                    @state,
                    owner_addr: *self.address,
                    owner_private_key: *self.private_key,
                    :note,
                    server: IServerDispatcher { contract_address: *self.client },
                )
            },
        )
    }

    fn use_note_server(self: @User, nullifier: felt252) {
        interact_with_state(
            *self.client,
            || {
                let mut state = Client::contract_state_for_testing();
                Client::ServerInternalTrait::use_note(ref state, :nullifier)
            },
        )
    }

    fn compute_nullifier(
        self: @User, sender: User, token: ContractAddress, note_index: usize,
    ) -> felt252 {
        compute_nullifier(
            channel_key: sender.compute_channel_key(recipient: *self, :token),
            index: note_index,
            owner_private_key: *self.private_key,
        )
    }

    // TODO: Remember index somewhere instead of passing it as an argument.
    fn new_note(
        self: @User, recipient: User, token: ContractAddress, amount: u128, index: usize,
    ) -> NewNote {
        NewNote { recipient_addr: recipient.address, token, amount, index }
    }

    // TODO: Consider different trait.
    fn get_note_server(self: @User, note_id: felt252) -> felt252 {
        IServerDispatcher { contract_address: *self.client }.get_note(:note_id)
    }

    fn deposit(
        self: @User, new_note: NewNote,
    ) -> (ContractAddress, ContractAddress, u128, EncNote) {
        IClientDispatcher { contract_address: *self.client }
            .prepare_deposit(owner_private_key: *self.private_key, :new_note)
    }

    #[feature("safe_dispatcher")]
    fn safe_deposit(
        self: @User, new_note: NewNote,
    ) -> Result<(ContractAddress, ContractAddress, u128, EncNote), Array<felt252>> {
        IClientSafeDispatcher { contract_address: *self.client }
            .prepare_deposit(owner_private_key: *self.private_key, :new_note)
    }

    // TODO: Consider different trait.
    fn nullifier_exists_server(self: @User, nullifier: felt252) -> bool {
        IServerDispatcher { contract_address: *self.client }.nullifier_exists(:nullifier)
    }

    // Server functions (renamed to avoid conflicts)
    fn get_num_of_channels(self: @User) -> u64 {
        IServerDispatcher { contract_address: *self.client }
            .get_num_of_channels(recipient_addr: *self.address)
    }

    fn get_channel_info(self: @User, channel_index: u64) -> EncChannelInfo {
        IServerDispatcher { contract_address: *self.client }
            .get_channel_info(recipient_addr: *self.address, :channel_index)
    }

    #[feature("safe_dispatcher")]
    fn safe_get_channel_info(
        self: @User, channel_index: u64,
    ) -> Result<EncChannelInfo, Array<felt252>> {
        IServerSafeDispatcher { contract_address: *self.client }
            .get_channel_info(recipient_addr: *self.address, :channel_index)
    }

    fn register(self: @User) {
        cheat_caller_address_once(contract_address: *self.client, caller_address: *self.address);
        IServerDispatcher { contract_address: *self.client }.register(public_key: *self.public_key)
    }

    #[feature("safe_dispatcher")]
    fn safe_register(self: @User) -> Result<(), Array<felt252>> {
        cheat_caller_address_once(contract_address: *self.client, caller_address: *self.address);
        IServerSafeDispatcher { contract_address: *self.client }
            .register(public_key: *self.public_key)
    }

    fn get_public_key(self: @User) -> felt252 {
        IServerDispatcher { contract_address: *self.client }
            .get_public_key(user_addr: *self.address)
    }

    fn replace_public_key(self: @User) {
        cheat_caller_address_once(contract_address: *self.client, caller_address: *self.address);
        IServerDispatcher { contract_address: *self.client }
            .replace_public_key(public_key: *self.public_key);
    }

    // TODO: Generate valid private-public key pair.
    /// Generate a new public key.
    fn new_public_key(ref self: User) {
        self.public_key = self.public_key * 2;
    }

    #[feature("safe_dispatcher")]
    fn safe_replace_public_key(self: @User) -> Result<(), Array<felt252>> {
        cheat_caller_address_once(contract_address: *self.client, caller_address: *self.address);
        IServerSafeDispatcher { contract_address: *self.client }
            .replace_public_key(public_key: *self.public_key)
    }

    fn approve_server(self: @User, token: Token, amount: u256) {
        let token_addr = token.contract_address();
        cheat_caller_address_once(contract_address: token_addr, caller_address: *self.address);
        IERC20Dispatcher { contract_address: token_addr }.approve(spender: *self.client, :amount);
    }

    fn deposit_server(self: @User, token: Token, amount: u128, note: EncNote) {
        self.approve_server(:token, amount: amount.into());
        IServerDispatcher { contract_address: *self.client }
            .deposit(user_addr: *self.address, token: token.contract_address(), :amount, :note);
    }

    #[feature("safe_dispatcher")]
    fn safe_deposit_server(
        self: @User, token: Token, amount: u128, note: EncNote,
    ) -> Result<(), Array<felt252>> {
        IServerSafeDispatcher { contract_address: *self.client }
            .deposit(user_addr: *self.address, token: token.contract_address(), :amount, :note)
    }

    fn withdraw_server(
        self: @User,
        recipient_addr: ContractAddress,
        token: Token,
        amount: u128,
        nullifier: felt252,
    ) {
        IServerDispatcher { contract_address: *self.client }
            .withdraw(:recipient_addr, token: token.contract_address(), :amount, :nullifier);
    }

    #[feature("safe_dispatcher")]
    fn safe_withdraw_server(
        self: @User,
        recipient_addr: ContractAddress,
        token: Token,
        amount: u128,
        nullifier: felt252,
    ) -> Result<(), Array<felt252>> {
        IServerSafeDispatcher { contract_address: *self.client }
            .withdraw(:recipient_addr, token: token.contract_address(), :amount, :nullifier)
    }
}

#[derive(Drop, Copy)]
pub(crate) struct Test {
    pub cfg: ClientCfg,
    pub nonce: usize,
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
            client: self.cfg.address,
            private_key,
            public_key,
            nonce: Zero::zero(),
        }
    }

    fn new_token(ref self: Test) -> ContractAddress {
        self.nonce += 1;
        ('TOKEN_ADDRESS' + self.nonce.into()).try_into().unwrap()
    }

    // Server test functions (renamed to avoid conflicts)
    /// Returns the encrypted channel information and the channel id.
    fn new_channel(ref self: Test) -> (EncChannelInfo, felt252) {
        self.nonce += 1;
        let enc_channel_info = EncChannelInfo {
            ephemeral_pubkey: ('EPHEMERAL_PUBKEY' + self.nonce.into()).try_into().unwrap(),
            enc_channel_key: ('ENC_CHANNEL_KEY' + self.nonce.into()).try_into().unwrap(),
            enc_token: ('ENC_TOKEN' + self.nonce.into()).try_into().unwrap(),
            enc_sender_addr: ('ENC_SENDER_ADDR' + self.nonce.into()).try_into().unwrap(),
        };
        let channel_id = ('CHANNEL_ID' + self.nonce.into()).try_into().unwrap();
        (enc_channel_info, channel_id)
    }

    /// Returns the note id and the encrypted note value.
    fn new_note_server(ref self: Test, amount: u128) -> EncNote {
        self.nonce += 1;
        let id = ('NOTE_ID' + self.nonce.into()).try_into().unwrap();
        // TODO: Encrypt amount properly.
        let enc_amount = ('ENC' + amount.into() + self.nonce.into()).try_into().unwrap();
        EncNote { id, enc_amount }
    }

    // TODO: Get note as input and generate appropriate nullifier.
    fn new_nullifier(ref self: Test) -> felt252 {
        self.nonce += 1;
        ('NULLIFIER' + self.nonce.into()).try_into().unwrap()
    }

    fn new_token_server(ref self: Test) -> Token {
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
pub(crate) impl ServerCfgImpl of ServerCfgTrait {
    fn open_channel(
        self: @ClientCfg,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannelInfo,
        channel_id: felt252,
    ) {
        IServerDispatcher { contract_address: *self.address }
            .open_channel(:recipient_addr, :enc_channel_info, :channel_id)
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel(
        self: @ClientCfg,
        recipient_addr: ContractAddress,
        enc_channel_info: EncChannelInfo,
        channel_id: felt252,
    ) -> Result<(), Array<felt252>> {
        IServerSafeDispatcher { contract_address: *self.address }
            .open_channel(:recipient_addr, :enc_channel_info, :channel_id)
    }

    fn channel_exists(self: @ClientCfg, channel_id: felt252) -> bool {
        IServerDispatcher { contract_address: *self.address }.channel_exists(:channel_id)
    }

    fn create_note(self: @ClientCfg, note: EncNote) {
        interact_with_state(
            *self.address,
            || {
                let mut state = Client::contract_state_for_testing();
                Client::ServerInternalTrait::create_note(ref state, :note)
            },
        )
    }

    fn get_note(self: @ClientCfg, note_id: felt252) -> felt252 {
        IServerDispatcher { contract_address: *self.address }.get_note(:note_id)
    }

    fn use_note(self: @ClientCfg, nullifier: felt252) {
        interact_with_state(
            *self.address,
            || {
                let mut state = Client::contract_state_for_testing();
                Client::ServerInternalTrait::use_note(ref state, :nullifier)
            },
        )
    }

    fn nullifier_exists(self: @ClientCfg, nullifier: felt252) -> bool {
        IServerDispatcher { contract_address: *self.address }.nullifier_exists(:nullifier)
    }

    fn transfer(self: @ClientCfg, nullifiers: Span<felt252>, new_notes: Span<EncNote>) {
        IServerDispatcher { contract_address: *self.address }.transfer(:nullifiers, :new_notes)
    }

    #[feature("safe_dispatcher")]
    fn safe_transfer(
        self: @ClientCfg, nullifiers: Span<felt252>, new_notes: Span<EncNote>,
    ) -> Result<(), Array<felt252>> {
        IServerSafeDispatcher { contract_address: *self.address }.transfer(:nullifiers, :new_notes)
    }
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let cfg = deploy_client();
        Test { cfg, nonce: Zero::zero() }
    }
}

/// Returns (channel_key, token, sender_addr) decrypted from the given `enc_channel_info` and
/// recipient's `private_key`.
pub(crate) fn decrypt_channel_info(
    enc_channel_info: EncChannelInfo, private_key: felt252,
) -> (felt252, ContractAddress, ContractAddress) {
    // Find shared point.
    let ephemeral_pubkey_point = EcPointTrait::new_from_x(x: enc_channel_info.ephemeral_pubkey)
        .unwrap();
    let shared_point = ephemeral_pubkey_point.mul(scalar: private_key);
    let shared_x = shared_point.try_into().unwrap().x();

    // Decrypt channel key.
    let decrypted_channel_key = enc_channel_info.enc_channel_key
        - compute_enc_channel_key_hash(:shared_x);

    // Decrypt token.
    let decrypted_token = enc_channel_info.enc_token - compute_enc_token_hash(:shared_x);

    // Decrypt sender address.
    let decrypted_sender_addr = enc_channel_info.enc_sender_addr
        - compute_enc_sender_addr_hash(:shared_x);

    (
        decrypted_channel_key,
        decrypted_token.try_into().unwrap(),
        decrypted_sender_addr.try_into().unwrap(),
    )
}
