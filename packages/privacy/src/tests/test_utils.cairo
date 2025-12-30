use core::ec::EcPointTrait;
use core::num::traits::Zero;
use core::traits::Neg;
use openzeppelin::token::erc20::interface::{IERC20Dispatcher, IERC20DispatcherTrait};
use privacy::interface::{
    IClientDispatcher, IClientDispatcherTrait, IClientSafeDispatcher, IClientSafeDispatcherTrait,
    IServerDispatcher, IServerDispatcherTrait, IServerSafeDispatcher, IServerSafeDispatcherTrait,
    IViewsDispatcher, IViewsDispatcherTrait, IViewsSafeDispatcher, IViewsSafeDispatcherTrait,
};
use privacy::objects::{EncChannelInfo, EncNote, EncSubchannelInfo, NewNote, NotePath, ServerAction};
use privacy::privacy::Privacy;
use privacy::privacy::Privacy::{ClientInternalTrait, deploy_for_test as deploy_privacy_for_test};
use privacy::utils::{
    compute_channel_id, compute_channel_key, compute_enc_channel_key_hash,
    compute_enc_sender_addr_hash, compute_enc_token_hash, compute_note_id, compute_nullifier,
    compute_subchannel_id, compute_subchannel_key, derive_public_key, encrypt_note_amount,
    encrypt_subchannel_info, hash, is_canonical_key,
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

// TODO: Consider removing the safe dispatchers.
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

// TODO: Consider renaming fn_name_server to server_fn_name.
#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> Span<ServerAction> {
        self
            .privacy
            .client
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
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .privacy
            .safe_client
            .prepare_transfer(
                owner_addr: *self.address,
                owner_private_key: *self.private_key,
                :notes_to_use,
                :notes_to_create,
            )
    }

    fn withdraw(
        self: @User, withdrawal_target: ContractAddress, note_to_withdraw: NotePath,
    ) -> Span<ServerAction> {
        self
            .privacy
            .client
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
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .privacy
            .safe_client
            .prepare_withdraw(
                owner_addr: *self.address,
                owner_private_key: *self.private_key,
                :withdrawal_target,
                :note_to_withdraw,
            )
    }

    fn open_channel(self: @User, recipient: User, random: felt252) -> Span<ServerAction> {
        self
            .privacy
            .client
            .prepare_open_channel(
                sender_addr: *self.address,
                sender_private_key: *self.private_key,
                recipient_addr: recipient.address,
                :random,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_open_channel(
        self: @User, recipient: User, random: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        self
            .privacy
            .safe_client
            .prepare_open_channel(
                sender_addr: *self.address,
                sender_private_key: *self.private_key,
                recipient_addr: recipient.address,
                :random,
            )
    }

    /// Returns (random, output) where output is the output of `open_channel`.
    fn open_channel_with_generated_random(
        ref self: User, recipient: User,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random();
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
            .privacy
            .client
            .open_subchannel(
                sender_addr: *self.address,
                recipient_addr: recipient.address,
                :channel_key,
                :index,
                :token,
                :random,
            )
    }

    #[feature("safe_dispatcher")]
    fn safe_open_subchannel(
        self: @User, recipient: User, token: ContractAddress, index: usize, random: felt252,
    ) -> Result<Span<ServerAction>, Array<felt252>> {
        let channel_key = self.compute_channel_key(:recipient);
        self
            .privacy
            .safe_client
            .open_subchannel(
                sender_addr: *self.address,
                recipient_addr: recipient.address,
                :channel_key,
                :index,
                :token,
                :random,
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
            .privacy
            .safe_client
            .open_subchannel(
                sender_addr: *self.address,
                recipient_addr: recipient.address,
                :channel_key,
                :index,
                :token,
                :random,
            )
    }

    /// Returns (random, output) where output is the output of `open_subchannel`.
    fn open_subchannel_with_generated_random(
        ref self: User, recipient: User, token: ContractAddress, index: usize,
    ) -> (felt252, Span<ServerAction>) {
        let random = self.get_random();
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

    /// TODO: Returns a random value of 120 bits.
    fn get_random(ref self: User) -> felt252 {
        self.nonce += 1;
        hash(['RANDOM', self.nonce.into()].span())
    }

    /// Internal function to create a note in the client side.
    fn create_note(self: @User, note: NewNote) -> EncNote {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                state
                    .create_note(
                        owner_addr: *self.address, owner_private_key: *self.private_key, :note,
                    )
            },
        )
    }

    fn cheat_create_note_e2e(self: @User, note: NewNote) {
        let enc_note = self.create_note(:note);
        self.privacy.cheat_create_note(note: enc_note);
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
        random: felt252,
    ) -> EncNote {
        let channel_key = self.compute_channel_key(:recipient);
        let note_id = compute_note_id(:channel_key, :token, :index);
        let enc_amount = encrypt_note_amount(:channel_key, :random, :amount);
        EncNote { id: note_id, enc_amount }
    }

    /// Internal function to use a note in the client side.
    fn use_note(self: @User, note: NotePath) -> (felt252, u128) {
        interact_with_state(
            *self.privacy.address,
            || {
                let mut state = Privacy::contract_state_for_testing();
                state
                    .use_note(
                        owner_addr: *self.address, owner_private_key: *self.private_key, :note,
                    )
            },
        )
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

    // TODO: Remember index somewhere instead of passing it as an argument.
    fn new_note(
        self: @User,
        recipient: User,
        token: ContractAddress,
        amount: u128,
        index: usize,
        random: felt252,
    ) -> NewNote {
        NewNote { recipient_addr: recipient.address, token, amount, index, random }
    }

    fn new_note_with_generated_random(
        ref self: User, recipient: User, token: ContractAddress, amount: u128, index: usize,
    ) -> NewNote {
        let random = self.get_random();
        self.new_note(:recipient, :token, :amount, :index, :random)
    }

    fn deposit(self: @User, new_note: NewNote) -> Span<ServerAction> {
        self.privacy.client.prepare_deposit(owner_private_key: *self.private_key, :new_note)
    }

    #[feature("safe_dispatcher")]
    fn safe_deposit(self: @User, new_note: NewNote) -> Result<Span<ServerAction>, Array<felt252>> {
        self.privacy.safe_client.prepare_deposit(owner_private_key: *self.private_key, :new_note)
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

    fn register(self: @User) -> Span<ServerAction> {
        cheat_caller_address_once(
            contract_address: *self.privacy.address, caller_address: *self.address,
        );
        self.privacy.client.register(public_key: *self.public_key)
    }

    fn register_e2e(self: @User) {
        let actions = self.register();
        self.privacy.server.execute_actions(:actions);
    }

    #[feature("safe_dispatcher")]
    fn safe_register(self: @User) -> Result<Span<ServerAction>, Array<felt252>> {
        cheat_caller_address_once(
            contract_address: *self.privacy.address, caller_address: *self.address,
        );
        self.privacy.safe_client.register(public_key: *self.public_key)
    }

    fn get_public_key(self: @User) -> felt252 {
        self.privacy.views.get_public_key(user_addr: *self.address)
    }

    fn replace_public_key(self: @User) -> Span<ServerAction> {
        cheat_caller_address_once(
            contract_address: *self.privacy.address, caller_address: *self.address,
        );
        self.privacy.client.replace_public_key(public_key: *self.public_key)
    }

    // TODO: Generate valid private-public key pair.
    /// Generate a new public key.
    fn new_public_key(ref self: User) {
        self.public_key = self.public_key * 2;
    }

    #[feature("safe_dispatcher")]
    fn safe_replace_public_key(self: @User) -> Result<Span<ServerAction>, Array<felt252>> {
        cheat_caller_address_once(
            contract_address: *self.privacy.address, caller_address: *self.address,
        );
        self.privacy.safe_client.replace_public_key(public_key: *self.public_key)
    }

    fn replace_public_key_e2e(self: @User) {
        let actions = self.replace_public_key();
        self.privacy.server.execute_actions(:actions);
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
            ServerAction::AppendToVec((recipient_addr, enc_channel_info)),
        ]
            .span();
        self.execute_actions(:actions);
    }

    fn channel_exists(self: @PrivacyCfg, channel_id: felt252) -> bool {
        self.views.channel_exists(:channel_id)
    }

    fn subchannel_exists(self: @PrivacyCfg, subchannel_id: felt252) -> bool {
        IViewsDispatcher { contract_address: *self.address }.subchannel_exists(:subchannel_id)
    }

    fn get_subchannel_info(self: @PrivacyCfg, subchannel_key: felt252) -> EncSubchannelInfo {
        IViewsDispatcher { contract_address: *self.address }.get_subchannel_info(:subchannel_key)
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
        let privacy = deploy_privacy();
        Test { privacy, nonce: Zero::zero() }
    }
}

pub(crate) fn deploy_privacy() -> PrivacyCfg {
    let contract_class_hash = declare(contract: "Privacy").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_privacy_for_test(
        class_hash: *contract_class_hash, :deployment_params,
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
