use constants::{ESTIMATION_BASE_TX_VERSION, TX_V3};
#[cfg(test)]
use constants::{VIRTUAL_SNOS, VIRTUAL_SNOS0};
use core::ec::stark_curve::{GEN_X, GEN_Y};
use core::ec::{EcPoint, EcPointTrait};
use core::never;
use core::num::traits::{WrappingAdd, WrappingSub, Zero};
use core::poseidon::poseidon_hash_span;
use privacy::actions::{ClientAction, ServerAction, WriteOnceInput};
use privacy::errors;
use privacy::errors::internal_errors;
use privacy::hashes::{
    compute_enc_amount_hash, compute_enc_channel_key_hash, compute_enc_private_key_hash,
    compute_enc_recipient_addr_hash, compute_enc_sender_addr_hash, compute_enc_token_hash,
    compute_enc_user_addr_hash,
};
use privacy::objects::{
    EncChannelInfo, EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo, EncUserAddr, Note,
};
use privacy::utils::constants::{
    ENTRYPOINT_FAILED, HALF_ORDER, OK_WRAPPER, OPEN_NOTE_PACKED_VALUE, OPEN_NOTE_SALT, TWO_POW_120,
};
use starknet::account::Call;
use starknet::storage::{StorageAsPointer, StoragePath};
use starknet::syscalls::{get_class_hash_at_syscall, send_message_to_l1_syscall};
use starknet::{ContractAddress, Store, SyscallResultTrait, TxInfo, VALIDATED};

#[starknet::interface]
pub(crate) trait IAccount<TState> {
    fn is_valid_signature(self: @TState, hash: felt252, signature: Array<felt252>) -> felt252;
}

pub mod constants {
    use core::ec::stark_curve::ORDER;
    use core::num::traits::{Pow, Zero};
    use starknet::ContractAddress;
    use starkware_utils::constants::TWO_POW_128;

    /// The salt value in the [`Note`](privacy::objects::Note) (packed with the amount in
    /// `packed_value`) identifies which type of note it is;
    /// salt = 0 means the note does not exist.
    /// salt = OPEN_NOTE_SALT (=1) means the note is an open note (store amounts in plaintext).
    /// salt > OPEN_NOTE_SALT (>=2) means the note is an encrypted note (store encrypted amounts).
    pub const OPEN_NOTE_SALT: u128 = 1;
    pub const TWO_POW_120: u128 = 2_u128.pow(120);
    pub const ENTRYPOINT_FAILED: felt252 = 'ENTRYPOINT_FAILED';
    pub const OK_WRAPPER: felt252 = 'PRIVACY_OK_WRAPPER';
    pub const TX_V3: felt252 = 3;
    /// The offset of simulated transactions.
    pub const ESTIMATION_BASE_TX_VERSION: felt252 = TWO_POW_128.try_into().unwrap();
    /// The packed value for open notes: `pack(salt = OPEN_NOTE_SALT = 1, amount = 0)`.
    pub const OPEN_NOTE_PACKED_VALUE: felt252 = u256 { high: OPEN_NOTE_SALT, low: Zero::zero() }
        .try_into()
        .unwrap();
    /// The program variant for the virtual Starknet OS.
    pub const VIRTUAL_SNOS: felt252 = 'VIRTUAL_SNOS';
    /// The output version for the virtual Starknet OS.
    pub const VIRTUAL_SNOS0: felt252 = 'VIRTUAL_SNOS0';
    /// Selector called with the [`Invoke`](privacy::actions::ServerAction::Invoke) action.
    pub const INVOKE_SELECTOR: felt252 = selector!("privacy_invoke");
    /// STRK fee token address — same on all Starknet networks (mainnet, sepolia, devnet).
    pub const STRK_TOKEN_ADDRESS: ContractAddress =
        0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
        .try_into()
        .unwrap();
    /// Half the order of the Stark curve.
    pub const HALF_ORDER: u256 = ORDER.into() / 2_u256;
}

/// Returns the generator point.
pub fn GEN_P() -> EcPoint {
    EcPointTrait::new(x: GEN_X, y: GEN_Y).unwrap()
}

/// Encrypts the subchannel info.
/// Assumes all the inputs (except `index`) are not zero.
///
/// The salt is used to guarantee one-time key usage, preventing privacy-related data leakage
/// if a transaction is reverted and the same subchannel id is reused.
///
/// `enc_subchannel_info = (salt, enc_token)`.
/// `enc_token = h(ENC_TOKEN_TAG, channel_key, index, 0, salt) + token`
pub(crate) fn encrypt_subchannel_info(
    channel_key: felt252, index: usize, token: ContractAddress, salt: felt252,
) -> EncSubchannelInfo {
    let enc_token = compute_enc_token_hash(:channel_key, :index, :salt) + token.into();
    EncSubchannelInfo { salt, enc_token }
}

/// Computes the shared x-coordinate for ECDH.
/// Assumes all the inputs are not zero.
/// Returns non-zero (`ephemeral_public_key` (x-coordinate), `shared_secret` (x-coordinate)).
///
/// High-level overview:
/// - `ephemeral_secret` is a freshly generated random scalar `r`.
/// - The ephemeral public key `R = rG` is published (x-coordinate only).
/// - Both parties derive the same shared secret:
///   `S = r * public_key = private_key * R`,
///   using only the x-coordinate as the shared secret material.
fn _compute_shared_x(ephemeral_secret: felt252, public_key: felt252) -> (felt252, felt252) {
    // Compute ephemeral public key.
    let ephemeral_pub_point = GEN_P().mul(scalar: ephemeral_secret);
    let ephemeral_pub_x = ephemeral_pub_point
        .try_into()
        .expect(internal_errors::ZERO_EPHEMERAL_PUBLIC)
        .x();
    // Compute shared point.
    let public_point = EcPointTrait::new_from_x(x: public_key)
        .expect(internal_errors::INVALID_PUBLIC_KEY);
    let shared_point = public_point.mul(scalar: ephemeral_secret);
    let shared_x = shared_point.try_into().expect(internal_errors::ZERO_SHARED).x();
    (ephemeral_pub_x, shared_x)
}

/// Encrypts the outgoing channel info.
/// Assumes all the inputs (except `index`) are not zero.
///
/// `enc_outgoing_channel_info = (salt, enc_recipient_addr)`.
/// `enc_recipient_addr = h(ENC_RECIPIENT_ADDR_TAG, sender_addr, sender_private_key, index, 0, salt)
/// + recipient_addr`
pub(crate) fn encrypt_outgoing_channel_info(
    sender_addr: ContractAddress,
    sender_private_key: felt252,
    index: usize,
    recipient_addr: ContractAddress,
    salt: felt252,
) -> EncOutgoingChannelInfo {
    let enc_recipient_addr = compute_enc_recipient_addr_hash(
        :sender_addr, :sender_private_key, :index, :salt,
    )
        + recipient_addr.into();
    EncOutgoingChannelInfo { salt, enc_recipient_addr }
}

/// Encrypts channel info using ECDH.
/// Assumes all the inputs are not zero.
///
/// High level:
/// - Sender picks a fresh random scalar `r` (= `ephemeral_secret`).
/// - Sender publishes the ephemeral public key `R = rG` (only the x-coordinate is stored).
/// - Sender derives a shared secret with the recipient:
///   `S = r * K_recipient`, where `K_recipient` is the recipient’s public key as a curve point
///   (only the x-coordinate is used as the shared secret material).
///
/// Specifically, we output:
/// - `ephemeral_pubkey = (rG).x`
/// - `enc_channel_key  = h( ENC_CHANNEL_KEY_TAG, (rK_recipient).x ) + channel_key`
/// - `enc_sender_addr  = h( ENC_SENDER_ADDR_TAG, (rK_recipient).x ) + sender_addr`
//
/// Decryption (Recipient):
/// - Reconstruct `R` from `R.x` (curve point recovery).
/// - Compute `S = k_recipient * R = k_recipient * (rG)`.
/// - Take `S.x` and subtract the same hash masks to recover the plaintext fields.
pub(crate) fn encrypt_channel_info(
    ephemeral_secret: felt252,
    recipient_public_key: felt252,
    channel_key: felt252,
    sender_addr: ContractAddress,
) -> EncChannelInfo {
    let (ephemeral_pub_x, shared_x) = _compute_shared_x(
        :ephemeral_secret, public_key: recipient_public_key,
    );
    // Encrypt channel information.
    let enc_channel_key = compute_enc_channel_key_hash(:shared_x) + channel_key;
    let enc_sender_addr = compute_enc_sender_addr_hash(:shared_x) + sender_addr.into();
    EncChannelInfo { ephemeral_pubkey: ephemeral_pub_x, enc_channel_key, enc_sender_addr }
}

/// Encrypts the private key for the auditor using ECDH.
/// Assumes all the inputs are not zero.
///
/// High level:
/// - User picks a fresh random scalar `r` (= `ephemeral_secret`).
/// - User publishes the ephemeral public key `R = rG` (only the x-coordinate is stored).
/// - User derives a shared secret with the auditor:
///   `S = r * K_auditor`, where `K_auditor` is the auditor's public key as
///   a curve point (only the x-coordinate is used as the shared secret material).
///
/// Specifically, we output:
/// - `ephemeral_pubkey = (rG).x`
/// - `enc_private_key  = h( ENC_PRIVATE_KEY_TAG, (rK_auditor).x ) + private_key`
///
/// Decryption (Auditor):
/// - Reconstruct `R` from `R.x` (curve point recovery).
/// - Compute `S = k_auditor * R = k_auditor * (rG)`.
/// - Take `S.x` and subtract the same hash masks to recover the plaintext fields.
pub(crate) fn encrypt_private_key(
    ephemeral_secret: felt252, auditor_public_key: felt252, private_key: felt252,
) -> EncPrivateKey {
    let (ephemeral_pub_x, shared_x) = _compute_shared_x(
        :ephemeral_secret, public_key: auditor_public_key,
    );
    // Encrypt channel information.
    let enc_private_key = compute_enc_private_key_hash(:shared_x) + private_key;
    EncPrivateKey { auditor_public_key, ephemeral_pubkey: ephemeral_pub_x, enc_private_key }
}

/// Encrypts the user address when withdrawing for the auditor using ECDH.
/// Assumes all the inputs are not zero.
///
/// High level:
/// - User picks a fresh random scalar `r` (= `ephemeral_secret`).
/// - User publishes the ephemeral public key `R = rG` (only the x-coordinate is stored).
/// - User derives a shared secret with the auditor:
///   `S = r * K_auditor`, where `K_auditor` is the auditor's public key as
///   a curve point (only the x-coordinate is used as the shared secret material).
///
/// Specifically, we output:
/// - `ephemeral_pubkey = (rG).x`
/// - `enc_user_addr  = h( ENC_USER_ADDR_TAG, (rK_auditor).x ) + user_addr`
///
/// Decryption (Auditor):
/// - Reconstruct `R` from `R.x` (curve point recovery).
/// - Compute `S = k_auditor * R = k_auditor * (rG)`.
/// - Take `S.x` and subtract the same hash masks to recover the plaintext fields.
pub(crate) fn encrypt_user_addr(
    ephemeral_secret: felt252, auditor_public_key: felt252, user_addr: ContractAddress,
) -> EncUserAddr {
    let (ephemeral_pub_x, shared_x) = _compute_shared_x(
        :ephemeral_secret, public_key: auditor_public_key,
    );
    // Encrypt address.
    let enc_user_addr = compute_enc_user_addr_hash(:shared_x) + user_addr.into();
    EncUserAddr { auditor_public_key, ephemeral_pubkey: ephemeral_pub_x, enc_user_addr }
}


/// Derives the public key from the private key.
/// Assumes the private key is not zero.
/// Returns non-zero public key.
pub(crate) fn derive_public_key(private_key: felt252) -> felt252 {
    let private_key_point = GEN_P().mul(scalar: private_key);
    private_key_point.try_into().expect(internal_errors::ZERO_DERIVED_PUBLIC_KEY).x()
}

/// Checks if the key is canonical, i.e. less than ORDER / 2.
pub(crate) fn is_canonical_key(key: felt252) -> bool {
    key.into() < HALF_ORDER
}

/// Encrypts the note amount for encrypted notes.
/// The encrypted amount is computed modulo 2^128.
/// Assumes all the inputs (except `index`) are not zero.
///
/// The salt is used to guarantee one-time key usage, preventing privacy-related data leakage
/// if a transaction is reverted and the same note id is reused.
///
/// `enc_amount = (h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt) + amount) % 2^128`.
pub(crate) fn _encrypt_note_amount(
    channel_key: felt252, token: ContractAddress, index: usize, salt: u128, amount: u128,
) -> u128 {
    let enc_amount_hash: u256 = compute_enc_amount_hash(:channel_key, :token, :index, :salt).into();
    enc_amount_hash.low.wrapping_add(amount)
}

/// Returns the packed value for an encrypted note.
/// Encrypts the note amount using `_encrypt_note_amount`. The result is packed into a single
/// felt252 value.
/// The first 120 bits are the salt, and the last 128 bits are the encrypted amount.
/// Assumes all the inputs (except `index`) are not zero and `salt` is 120 bits.
///
/// `packed_value = pack(salt, enc_amount)`.
/// `enc_amount = (h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt) + amount) % 2^128`.
pub(crate) fn enc_note_packed_value(
    channel_key: felt252, token: ContractAddress, index: usize, salt: u128, amount: u128,
) -> felt252 {
    let enc_amount: u128 = _encrypt_note_amount(:channel_key, :token, :index, :salt, :amount);
    pack(value_1: salt, value_2: enc_amount)
}

/// Decrypts `enc_amount` using the other parameters.
/// This is the inverse of `_encrypt_note_amount`.
pub(crate) fn decrypt_note_amount(
    enc_amount: u128, salt: u128, channel_key: felt252, token: ContractAddress, index: usize,
) -> u128 {
    let enc_amount_hash: u256 = compute_enc_amount_hash(:channel_key, :token, :index, :salt).into();
    enc_amount.wrapping_sub(enc_amount_hash.low)
}

/// Returns the actual note amount from a packed value.
/// For open notes (OPEN_NOTE_SALT): returns the value directly.
/// For encrypted notes: decrypts using channel_key, token, and index.
/// In both cases, the returned amount may be zero.
pub(crate) fn decode_note_amount(
    packed_value: felt252, channel_key: felt252, token: ContractAddress, index: usize,
) -> u128 {
    let (salt, amount) = unpack(:packed_value);
    assert(salt.is_non_zero(), internal_errors::UNEXPECTED_ZERO_SALT);
    if salt == OPEN_NOTE_SALT {
        amount
    } else {
        decrypt_note_amount(enc_amount: amount, :salt, :channel_key, :token, :index)
    }
}

/// Converts a storage path to its felt252 address.
pub(crate) fn storage_path_to_felt252<T, +StorageAsPointer<StoragePath<T>>>(
    path: StoragePath<T>,
) -> felt252 {
    path.as_ptr().__storage_pointer_address__.into()
}

/// Packs two u128 values into a single felt252 value.
/// Equivalent to (value_1 << 128) | value_2.
/// Assumes: value_1 is 120 bits, value_2 is 128 bits.
pub(crate) fn pack(value_1: u128, value_2: u128) -> felt252 {
    let packed = u256 { high: value_1, low: value_2 };
    packed.try_into().expect(internal_errors::PACK_OVERFLOW)
}

/// Unpacks a single felt252 into two u128 values (120 bits for value_1, 128 bits for value_2).
/// Inverse of `pack`: `packed_value = value_1 * 2^128 + value_2`
pub(crate) fn unpack(packed_value: felt252) -> (u128, u128) {
    let u256 { high, low } = packed_value.into();
    // Sanity check that value_1 (high bits) is 120 bits.
    assert(high < TWO_POW_120, internal_errors::UNPACK1_OUT_OF_BOUNDS);
    (high, low)
}

/// Asserts that the calls are valid and deserializes the calldata.
/// Returns the input for `compile_actions` function: (user_addr, user_private_key, client_actions).
pub(crate) fn extract_compile_actions_inputs(
    calls: Array<Call>, contract_address: ContractAddress,
) -> (ContractAddress, felt252, Span<ClientAction>) {
    assert(calls.len() == 1, errors::EXPECTED_ONE_CALL);
    let call = calls[0];
    assert(*call.to == contract_address, errors::INVALID_CALL_TO);
    assert(*call.selector == selector!("compile_actions"), errors::INVALID_CALL_SELECTOR);
    let mut serialized = *call.calldata;
    let (user_addr, user_private_key, client_actions) = Serde::<
        (ContractAddress, felt252, Span<ClientAction>),
    >::deserialize(ref :serialized)
        .expect(errors::INVALID_CALLDATA);
    assert(serialized.is_empty(), errors::INVALID_CALLDATA);
    (user_addr, user_private_key, client_actions)
}

pub(crate) fn assert_valid_signature(user_addr: ContractAddress, tx_info: Box<TxInfo>) {
    let tx_hash = tx_info.transaction_hash;
    let signature = tx_info.signature.into();

    let user_account = IAccountDispatcher { contract_address: user_addr };
    let is_valid = user_account.is_valid_signature(hash: tx_hash, :signature);
    assert(is_valid == VALIDATED, errors::INVALID_SIGNATURE);
}

/// Sends server actions to L1.
/// The payload contains [contract_class_hash, serialized_server_actions].
pub(crate) fn send_message_to_server(
    server_actions: Span<ServerAction>, contract_address: ContractAddress,
) {
    let mut payload = array![];
    let class_hash = get_class_hash_at_syscall(contract_address).unwrap_syscall();
    class_hash.serialize(ref payload);
    server_actions.serialize(ref payload);
    send_message_to_l1_syscall(to_address: Zero::zero(), payload: payload.span()).unwrap_syscall();
}

/// Gets the result from `compile_and_panic` and returns the server actions on success.
/// Panics on failure with the result's panic data.
pub(crate) fn extract_server_actions_from_compile_and_panic(
    syscall_result: Result<Span<felt252>, Array<felt252>>,
) -> Span<ServerAction> {
    let origin_panic_data = syscall_result.expect_err(internal_errors::EXPECTED_PANIC).span();
    let mut panic_data = origin_panic_data;
    // On success, the panic data should be [`OK_WRAPPER`, <serialized_server_actions>,
    // `OK_WRAPPER`, `ENTRYPOINT_FAILED`].
    if panic_data.pop_front() != Some(@OK_WRAPPER) {
        panic(origin_panic_data.into());
    }
    let server_actions: Span<ServerAction> = Serde::deserialize(ref panic_data)
        .unwrap_or_else(|| panic(origin_panic_data.into()));
    if panic_data.pop_front() != Some(@OK_WRAPPER) {
        panic(origin_panic_data.into());
    }
    if panic_data.pop_front() != Some(@ENTRYPOINT_FAILED) {
        panic(origin_panic_data.into());
    }
    if !panic_data.is_empty() {
        panic(origin_panic_data.into());
    }
    server_actions
}

/// Wraps the server actions with `OK_WRAPPER` in a panic data array.
pub(crate) fn panic_with_server_actions(server_actions: Span<ServerAction>) -> never {
    let mut panic_data = array![];
    panic_data.append(OK_WRAPPER);
    server_actions.serialize(ref panic_data);
    panic_data.append(OK_WRAPPER);
    panic(panic_data);
}

/// IMPORTANT: This function only works for types whose serialization format
/// exactly matches their in-storage representation.
/// Use with care.
pub(crate) fn to_write_once_action<T, +Serde<T>, +Store<T>, +Drop<T>>(
    storage_address: felt252, value: T,
) -> ServerAction {
    let mut serialized_value = array![];
    value.serialize(ref output: serialized_value);
    ServerAction::WriteOnce(WriteOnceInput { storage_address, value: serialized_value.span() })
}

pub(crate) fn open_note(token: ContractAddress) -> Note {
    Note { packed_value: OPEN_NOTE_PACKED_VALUE, token }
}

#[derive(Drop, Serde, Debug, Copy)]
pub struct ProofFacts {
    /// The proof version.
    pub proof_version: felt252,
    /// The proven program variant; enforced to be
    /// [`VIRTUAL_SNOS`](privacy::utils::constants::VIRTUAL_SNOS).
    pub program_variant: felt252,
    /// The hash of the virtual Starknet OS program.
    pub virtual_program_hash: felt252,
    /// The output version; enforced to be
    /// [`VIRTUAL_SNOS0`](privacy::utils::constants::VIRTUAL_SNOS0).
    pub starknet_os_output_version: felt252,
    /// The base block number.
    pub base_block_number: u64,
    /// The base block hash.
    pub base_block_hash: felt252,
    /// The hash of the Starknet OS config.
    pub starknet_os_config_hash: felt252,
    /// Hashes of messages from L2 to L1.
    pub message_to_l1_hashes: Span<felt252>,
}

#[cfg(test)]
pub(crate) impl ProofFactsDefaultImpl of Default<ProofFacts> {
    fn default() -> ProofFacts {
        ProofFacts {
            proof_version: 0,
            program_variant: VIRTUAL_SNOS,
            virtual_program_hash: 0,
            starknet_os_output_version: VIRTUAL_SNOS0,
            base_block_number: starknet::get_block_number() - 1,
            base_block_hash: 0,
            starknet_os_config_hash: 0,
            message_to_l1_hashes: [].span(),
        }
    }
}

/// The message hash is computed from the L1 message, which includes:
/// - `from_address`: the privacy (self) contract address.
/// - `to_address`: zero.
/// - `payload_len`: length of the payload.
/// - `payload`: [contract_class_hash, serialized_server_actions] (server actions as passed to
/// `apply_actions`).
pub(crate) fn compute_message_hash(
    actions: Span<ServerAction>, contract_address: ContractAddress,
) -> felt252 {
    let mut l1_message_data: Array<felt252> = array![
        contract_address.into(), Zero::zero(),
    ]; // from address, to address.
    let mut payload = array![];
    let class_hash = get_class_hash_at_syscall(:contract_address).unwrap_syscall();
    class_hash.serialize(ref payload);
    actions.serialize(ref payload);
    payload.serialize(ref l1_message_data);
    poseidon_hash_span(l1_message_data.span())
}

/// Asserts that the call originates from the OS.
///
/// Enforced by requiring:
/// - a zero caller address, and
/// - a V3 transaction version (including its estimation variant).
///
/// During fee estimation, the tx version is offset by `ESTIMATION_BASE_TX_VERSION`
/// (e.g. 2^128 + 3) to distinguish simulated execution from real transactions.
/// Both forms are accepted.
pub(crate) fn assert_valid_os_call(caller_address: ContractAddress, tx_version: felt252) {
    assert(caller_address.is_zero(), errors::NON_ZERO_CALLER);
    // Allow canonical V3 or its estimation variant (base offset + V3).
    assert(
        tx_version == TX_V3 || tx_version == ESTIMATION_BASE_TX_VERSION + TX_V3,
        errors::INVALID_TX_VERSION,
    );
}
