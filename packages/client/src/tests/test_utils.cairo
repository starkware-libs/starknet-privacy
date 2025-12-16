use client::client::Client;
use client::client::Client::{ClientInternalTrait, deploy_for_test as deploy_client_for_test};
use client::interface::{
    IClientDispatcher, IClientDispatcherTrait, IClientSafeDispatcher, IClientSafeDispatcherTrait,
};
use client::objects::{NewNote, NotePath};
use client::utils::{
    compute_enc_channel_key_hash, compute_enc_sender_addr_hash, compute_enc_token_hash,
    derive_public_key, hash, is_canonical_key,
};
use core::ec::EcPointTrait;
use core::num::traits::Zero;
use core::traits::Neg;
use server::interface::{IServerDispatcher, IServerDispatcherTrait};
use server::objects::{EncChannelInfo, EncNote};
use server::server::Server;
use server::server::Server::{ServerInternalTrait, deploy_for_test as deploy_server_for_test};
use snforge_std::{DeclareResultTrait, declare, interact_with_state};
use starknet::ContractAddress;
use starknet::deployment::DeploymentParams;
use starknet::storage::StorableStoragePointerReadAccess;
use starkware_utils_testing::test_utils::cheat_caller_address_once;

#[derive(Copy, Drop)]
pub(crate) struct ClientCfg {
    pub address: ContractAddress,
    pub server: ContractAddress,
}

#[derive(Copy, Drop)]
struct User {
    pub address: ContractAddress,
    pub client: ContractAddress,
    pub server: ContractAddress,
    pub private_key: felt252,
    pub public_key: felt252,
    nonce: usize,
}

#[generate_trait]
pub(crate) impl UserImpl of UserTrait {
    fn transfer(
        self: @User, notes_to_use: Span<NotePath>, notes_to_create: Span<NewNote>,
    ) -> (Span<felt252>, Span<EncNote>) {
        IClientDispatcher { contract_address: *self.client }
            .transfer(
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
            .transfer(
                owner_addr: *self.address,
                owner_private_key: *self.private_key,
                :notes_to_use,
                :notes_to_create,
            )
    }

    fn open_channel(
        self: @User, recipient: User, token: ContractAddress, random: felt252,
    ) -> (ContractAddress, EncChannelInfo, felt252) {
        IClientDispatcher { contract_address: *self.client }
            .open_channel(
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
            .open_channel(
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
        IServerDispatcher { contract_address: *self.server }
            .open_channel(:recipient_addr, :enc_channel_info, :channel_id)
    }

    fn open_channel_e2e(ref self: User, recipient: User, token: ContractAddress) {
        let (_, channel_output) = self
            .open_channel_with_generated_random(recipient: recipient, :token);
        let (recipient_addr, enc_channel_info, channel_id) = channel_output;
        self._open_channel_server(:recipient_addr, :enc_channel_info, :channel_id)
    }

    fn register_server(self: @User) {
        cheat_caller_address_once(contract_address: *self.server, caller_address: *self.address);
        IServerDispatcher { contract_address: *self.server }.register(public_key: *self.public_key)
    }

    fn get_num_of_channels_server(self: @User) -> u64 {
        IServerDispatcher { contract_address: *self.server }
            .get_num_of_channels(recipient_addr: *self.address)
    }

    fn get_enc_channel_info_server(self: @User, channel_index: u64) -> EncChannelInfo {
        IServerDispatcher { contract_address: *self.server }
            .get_channel_info(recipient_addr: *self.address, :channel_index)
    }

    fn get_random(ref self: User) -> felt252 {
        self.nonce += 1;
        hash(['RANDOM', self.nonce.into()].span())
    }

    fn create_note(self: @User, note: NewNote) -> (EncNote, u128) {
        interact_with_state(
            *self.client,
            || {
                let mut state = Client::contract_state_for_testing();
                state
                    .create_note(
                        owner_addr: *self.address,
                        owner_private_key: *self.private_key,
                        :note,
                        server: IServerDispatcher { contract_address: *self.server },
                    )
            },
        )
    }

    fn create_note_server(self: @User, note: EncNote) {
        interact_with_state(
            *self.server,
            || {
                let mut state = Server::contract_state_for_testing();
                state.create_note(:note)
            },
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
        IServerDispatcher { contract_address: *self.server }.get_note(:note_id)
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
            server: self.cfg.server,
            private_key,
            public_key,
            nonce: Zero::zero(),
        }
    }

    fn new_token(ref self: Test) -> ContractAddress {
        self.nonce += 1;
        ('TOKEN_ADDRESS' + self.nonce.into()).try_into().unwrap()
    }
}

impl DefaultTestImpl of Default<Test> {
    fn default() -> Test {
        let cfg = deploy_client();
        Test { cfg, nonce: Zero::zero() }
    }
}

pub(crate) fn deploy_client() -> ClientCfg {
    let server = deploy_server();

    let contract_class_hash = declare(contract: "Client").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_client_for_test(
        class_hash: *contract_class_hash, :deployment_params, :server,
    )
        .expect('Client deployment failed');
    ClientCfg { address: contract_address, server }
}

// TODO: Import from server or shared package.
pub(crate) fn deploy_server() -> ContractAddress {
    let contract_class_hash = declare(contract: "Server").unwrap().contract_class().class_hash;
    let deployment_params = DeploymentParams { salt: 0, deploy_from_zero: true };
    let (contract_address, _) = deploy_server_for_test(
        class_hash: *contract_class_hash, :deployment_params,
    )
        .expect('Server deployment failed');
    contract_address
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
