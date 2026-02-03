use core::ec::stark_curve::{GEN_X, GEN_Y, ORDER};
use core::ec::{EcPoint, EcPointTrait};
use core::never;
use core::num::traits::{WrappingAdd, WrappingSub, Zero};
use privacy::actions::{ServerAction, WriteOnceInput};
use privacy::errors;
use privacy::errors::internal_errors;
use privacy::hashes::{
    compute_enc_address_hash, compute_enc_amount_hash, compute_enc_channel_key_hash,
    compute_enc_private_key_hash, compute_enc_recipient_addr_hash, compute_enc_sender_addr_hash,
    compute_enc_token_hash,
};
use privacy::objects::{
    EncChannelInfo, EncOutgoingChannelInfo, EncPrivateKey, EncSubchannelInfo, EncUserAddr, Note,
};
use privacy::utils::constants::{
    ENTRYPOINT_FAILED, OK_WRAPPER, OPEN_NOTE_PACKED_VALUE, OPEN_NOTE_SALT, TWO_POW_120, TX_V3,
};
use starknet::storage::{StorageAsPointer, StoragePath};
use starknet::syscalls::{call_contract_syscall, send_message_to_l1_syscall};
use starknet::{ContractAddress, ExecutionInfo, Store, SyscallResultTrait, TxInfo, VALIDATED};

pub mod constants {
    use core::num::traits::{Pow, Zero};

    /// The salt value in the [`Note`](privacy::objects::Note) (packed with the amount in
    /// `packed_value`) identifies which type of note it is;
    /// salt = 0 means the note does not exist.
    /// salt = OPEN_NOTE_SALT (=1) means the note is an open note (store amounts in plaintext).
    /// salt > OPEN_NOTE_SALT (>=2) means the note is an encrypted note (store encrypted amounts).
    pub const OPEN_NOTE_SALT: u128 = 1;
    pub const TWO_POW_120: u128 = 2_u128.pow(120);
    pub const ENTRYPOINT_FAILED: felt252 = 'ENTRYPOINT_FAILED';
    pub const OK_WRAPPER: felt252 = 'PRIVACY_OK_WRAPPER';
    pub const TX_V3: u64 = 3;
    pub const OPEN_NOTE_PACKED_VALUE: felt252 = u256 { high: OPEN_NOTE_SALT, low: Zero::zero() }
        .try_into()
        .unwrap();
}

/// Returns the generator point.
pub fn GEN_P() -> EcPoint {
    EcPointTrait::new(x: GEN_X, y: GEN_Y).unwrap()
}

/// Encrypts the subchannel info.
/// Assumes `channel_key` and `token` are not zero.
///
/// The salt is used to guarantee one-time key usage, preventing privacy-related data leakage
/// if a transaction is reverted and the same subchannel key is reused.
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
/// Returns (`ephemeral_public_key` (x-coordinate), `shared_secret` (x-coordinate)).
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
    let ephemeral_pub_x = ephemeral_pub_point.try_into().unwrap().x();
    // Compute shared point.
    let public_point = EcPointTrait::new_from_x(x: public_key).unwrap();
    let shared_point = public_point.mul(scalar: ephemeral_secret);
    let shared_x = shared_point.try_into().unwrap().x();
    (ephemeral_pub_x, shared_x)
}

/// Encrypts the outgoing channel info.
/// Assumes all the inputs (except `index` and `salt`) are not zero.
///
/// `enc_outgoing_channel_info = (salt, enc_recipient_addr)`.
/// `enc_recipient_addr = h(ENC_RECIPIENT_ADDR_TAG, sender_addr, sender_private_key, index, salt) +
/// recipient_addr`
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

/// Encrypts the private key for the compliance using ECDH.
/// Assumes all the inputs are not zero.
///
/// High level:
/// - User picks a fresh random scalar `r` (= `ephemeral_secret`).
/// - User publishes the ephemeral public key `R = rG` (only the x-coordinate is stored).
/// - User derives a shared secret with the compliance:
///   `S = r * K_compliance`, where `K_compliance` is the compliance's public key as a curve point
///   (only the x-coordinate is used as the shared secret material).
///
/// Specifically, we output:
/// - `ephemeral_pubkey = (rG).x`
/// - `enc_private_key  = h( ENC_PRIVATE_KEY_TAG, (rK_compliance).x ) + private_key`
///
/// Decryption (Compliance):
/// - Reconstruct `R` from `R.x` (curve point recovery).
/// - Compute `S = k_compliance * R = k_compliance * (rG)`.
/// - Take `S.x` and subtract the same hash masks to recover the plaintext fields.
pub(crate) fn encrypt_private_key(
    ephemeral_secret: felt252, compliance_public_key: felt252, private_key: felt252,
) -> EncPrivateKey {
    let (ephemeral_pub_x, shared_x) = _compute_shared_x(
        :ephemeral_secret, public_key: compliance_public_key,
    );
    // Encrypt channel information.
    let enc_private_key = compute_enc_private_key_hash(:shared_x) + private_key;
    EncPrivateKey { compliance_public_key, ephemeral_pubkey: ephemeral_pub_x, enc_private_key }
}

/// Encrypts the user address when withdrawing for the compliance using ECDH.
/// Assumes all the inputs are not zero.
///
/// High level:
/// - User picks a fresh random scalar `r` (= `ephemeral_secret`).
/// - User publishes the ephemeral public key `R = rG` (only the x-coordinate is stored).
/// - User derives a shared secret with the compliance:
///   `S = r * K_compliance`, where `K_compliance` is the compliance's public key as a curve point
///   (only the x-coordinate is used as the shared secret material).
///
/// Specifically, we output:
/// - `ephemeral_pubkey = (rG).x`
/// - `enc_user_addr  = h( ENC_USER_ADDR_TAG, (rK_compliance).x ) + user_addr`
///
/// Decryption (Compliance):
/// - Reconstruct `R` from `R.x` (curve point recovery).
/// - Compute `S = k_compliance * R = k_compliance * (rG)`.
/// - Take `S.x` and subtract the same hash masks to recover the plaintext fields.
pub(crate) fn encrypt_user_addr(
    ephemeral_secret: felt252, compliance_public_key: felt252, user_addr: ContractAddress,
) -> EncUserAddr {
    let (ephemeral_pub_x, shared_x) = _compute_shared_x(
        :ephemeral_secret, public_key: compliance_public_key,
    );
    // Encrypt address.
    let enc_user_addr = compute_enc_address_hash(:shared_x) + user_addr.into();
    EncUserAddr { compliance_public_key, ephemeral_pubkey: ephemeral_pub_x, enc_user_addr }
}


/// Derives the public key from the private key.
/// Assumes the private key is not zero.
pub(crate) fn derive_public_key(private_key: felt252) -> felt252 {
    let private_key_point = GEN_P().mul(scalar: private_key);
    private_key_point.try_into().unwrap().x()
}

/// Checks if the key is canonical, i.e. less than ORDER / 2.
pub(crate) fn is_canonical_key(key: felt252) -> bool {
    key.into() < (ORDER.into() / 2_u256)
}

/// Encrypts the note amount. The result is packed into a single felt252 value.
/// The first 120 bits are the salt, and the last 128 bits are the encrypted amount.
/// The encrypted amount is computed modulo 2^128.
/// Assumes `channel_key`, `token` and `amount` are not zero, and `salt` is 120 bits.
///
/// The salt is used to guarantee one-time key usage, preventing privacy-related data leakage
/// if a transaction is reverted and the same note id is reused.
///
/// `enc_amount = packing(salt, (h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt) + amount)
/// % 2^128)`.
pub(crate) fn encrypt_note_amount(
    channel_key: felt252, token: ContractAddress, index: usize, salt: u128, amount: u128,
) -> felt252 {
    let enc_amount_hash: u256 = compute_enc_amount_hash(:channel_key, :token, :index, :salt).into();
    let enc_amount: u128 = enc_amount_hash.low.wrapping_add(amount);
    packing(value_1: salt, value_2: enc_amount)
}

/// Decrypts `enc_amount` using the other parameters.
/// This is the inverse of `encrypt_note_amount`.
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
    let (salt, amount) = unpacking(:packed_value);
    assert(salt.is_non_zero(), internal_errors::UNEXPECTED_ZERO_SALT);
    if salt == OPEN_NOTE_SALT {
        amount
    } else {
        decrypt_note_amount(enc_amount: amount, :salt, :channel_key, :token, :index)
    }
}

pub(crate) impl StoragePathIntoFelt<
    T, +StorageAsPointer<StoragePath<T>>,
> of Into<StoragePath<T>, felt252> {
    fn into(self: StoragePath<T>) -> felt252 {
        self.as_ptr().__storage_pointer_address__.into()
    }
}

/// Packs two u128 values into a single felt252 value.
/// Equivalent to (value_1 << 128) | value_2.
/// Assumes: value_1 is 120 bits, value_2 is 128 bits.
pub(crate) fn packing(value_1: u128, value_2: u128) -> felt252 {
    let packed = u256 { high: value_1, low: value_2 };
    packed.try_into().expect(internal_errors::PACK_OVERFLOW)
}

/// Unpacks a single felt252 into two u128 values (120 bits for value_1, 128 bits for value_2).
/// Inverse of `packing`: `packed_value = value_1 * 2^128 + value_2`
pub(crate) fn unpacking(packed_value: felt252) -> (u128, u128) {
    let packed_u256: u256 = packed_value.into();
    // Sanity check that value_1 (high bits) is 120 bits.
    assert(packed_u256.high < TWO_POW_120, internal_errors::UNPACK1_OUT_OF_BOUNDS);
    (packed_u256.high, packed_u256.low)
}

pub(crate) fn assert_valid_execution_info(execution_info: Box<ExecutionInfo>) {
    // Ensure that the current call is the first of the transaction,
    // (by checking that the caller address is zero and disabling V0 meta tx syscalls).
    assert(execution_info.caller_address.is_zero(), errors::NON_ZERO_CALLER);
    let tx_info = execution_info.tx_info;
    assert(tx_info.version.try_into().unwrap() >= TX_V3, errors::INVALID_TX_VERSION);
    // Ensure that the effective fee of the transaction is zero; this is a sanity check,
    // to prevent the execution of this code over Starknet.
    assert(tx_info.tip.is_zero(), errors::NON_ZERO_TIP);
    for resource_bounds in tx_info.resource_bounds {
        assert(resource_bounds.max_price_per_unit.is_zero(), errors::NON_ZERO_RESOURCE_PRICE);
    }
}

pub(crate) fn assert_valid_signature(user_addr: ContractAddress, tx_info: Box<TxInfo>) {
    let tx_hash = tx_info.transaction_hash;
    let signature = tx_info.signature;

    // Use syscall to wrap possible panics with `ERROR_WRAPPER`.
    let mut calldata = array![];
    tx_hash.serialize(ref calldata);
    signature.serialize(ref calldata);
    let syscall_result = call_contract_syscall(
        address: user_addr,
        entry_point_selector: selector!("is_valid_signature"),
        calldata: calldata.span(),
    );
    let mut serialized_result = syscall_result.unwrap_syscall();
    let is_valid: felt252 = Serde::deserialize(ref serialized_result)
        .expect(internal_errors::DESERIALIZE_FAILED);
    assert(is_valid == VALIDATED, errors::INVALID_SIGNATURE);
}

pub(crate) fn send_message_to_server(server_actions: Span<ServerAction>) {
    let mut payload = array![];
    server_actions.serialize(ref payload);
    send_message_to_l1_syscall(to_address: Zero::zero(), payload: payload.span()).unwrap_syscall();
}

pub(crate) fn unwrap_execute_and_panic_result(
    syscall_result: Result<Span<felt252>, Array<felt252>>,
) -> Span<felt252> {
    let mut panic_message = syscall_result.expect_err(internal_errors::EXPECTED_PANIC);
    let message_len = panic_message.len();
    assert(*panic_message[message_len - 1] == ENTRYPOINT_FAILED, internal_errors::EXPECTED_PANIC);
    #[allow(manual_assert)]
    if *panic_message[0] != OK_WRAPPER || *panic_message[message_len - 2] != OK_WRAPPER {
        panic(panic_message);
    }

    let _ = panic_message.pop_front();
    // TODO: Consider also popping the last 2 elements.
    panic_message.span()
}

/// Wraps the server actions with `OK_WRAPPER` in a panic data array.
pub(crate) fn panic_with_server_actions(server_actions: Span<ServerAction>) -> never {
    let mut panic_data = array![];
    panic_data.append(OK_WRAPPER);
    server_actions.serialize(ref panic_data);
    panic_data.append(OK_WRAPPER);
    panic(panic_data);
}

/// Validates common input parameters for note creation.
pub(crate) fn assert_note_creation_params(
    recipient_addr: ContractAddress, recipient_public_key: felt252, token: ContractAddress,
) {
    assert(recipient_addr.is_non_zero(), errors::ZERO_RECIPIENT_ADDR);
    assert(recipient_public_key.is_non_zero(), errors::ZERO_RECIPIENT_PUBLIC_KEY);
    assert(token.is_non_zero(), errors::ZERO_TOKEN);
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

pub(crate) fn open_note(token: ContractAddress, depositor: ContractAddress) -> Note {
    Note { packed_value: OPEN_NOTE_PACKED_VALUE, token, depositor }
}
