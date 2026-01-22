/// Reference hash generator for TypeScript SDK compatibility testing.
///
/// This test is ignored by default. Run explicitly with:
///   snforge test generate_reference_hashes --include-ignored
///
/// The output should be used to update: sdk/tests/fixtures/cairo-reference-hashes.json
use privacy::hashes::{
    compute_channel_id, compute_channel_key, compute_enc_amount_hash, compute_enc_channel_key_hash,
    compute_enc_private_key_hash, compute_enc_recipient_addr_hash, compute_enc_sender_addr_hash,
    compute_enc_token_hash, compute_note_id, compute_nullifier, compute_outgoing_channel_key,
    compute_subchannel_id, compute_subchannel_key, domain_separation::*,
};
use privacy::utils::{
    decrypt_note_amount, derive_public_key, encrypt_channel_info, encrypt_note_amount,
    encrypt_subchannel_info,
};
use starknet::ContractAddress;

// Test inputs - must match sdk/tests/fixtures/cairo-reference-hashes.json
const SENDER: felt252 = 0x123;
const RECIPIENT: felt252 = 0x456;
const SENDER_PRIVATE_KEY: felt252 = 0x789;
const RECIPIENT_PUBLIC_KEY: felt252 = 0xabc;
const CHANNEL_KEY: felt252 = 0xdef;
const TOKEN: felt252 = 0x1234;
const INDEX: usize = 5;
const SALT: u128 = 0x5678;
const SHARED_X: felt252 = 0x9abc;
// Additional inputs for encryption tests
const EPHEMERAL_SECRET: felt252 = 0xabcd;
const AMOUNT: u128 = 1000;

fn to_address(addr: felt252) -> ContractAddress {
    addr.try_into().unwrap()
}

#[test]
#[ignore]
fn generate_reference_hashes() {
    let sender = to_address(SENDER);
    let recipient = to_address(RECIPIENT);
    let token = to_address(TOKEN);

    // Compute hash values
    let channel_key = compute_channel_key(
        sender, SENDER_PRIVATE_KEY, recipient, RECIPIENT_PUBLIC_KEY,
    );
    let channel_id = compute_channel_id(CHANNEL_KEY, sender, recipient, RECIPIENT_PUBLIC_KEY);
    let subchannel_key = compute_subchannel_key(CHANNEL_KEY, INDEX);
    let subchannel_id = compute_subchannel_id(CHANNEL_KEY, recipient, RECIPIENT_PUBLIC_KEY, token);
    let note_id = compute_note_id(CHANNEL_KEY, token, INDEX);
    let nullifier = compute_nullifier(CHANNEL_KEY, token, INDEX, SENDER_PRIVATE_KEY);

    // Outgoing channel key
    let outgoing_channel_key = compute_outgoing_channel_key(sender, SENDER_PRIVATE_KEY, INDEX);

    // Encryption hashes
    let enc_amount_hash = compute_enc_amount_hash(CHANNEL_KEY, token, INDEX, SALT);
    let enc_token_hash = compute_enc_token_hash(CHANNEL_KEY, INDEX, SALT.into());
    let enc_private_key_hash = compute_enc_private_key_hash(SHARED_X);
    let enc_channel_key_hash = compute_enc_channel_key_hash(SHARED_X);
    let enc_sender_addr_hash = compute_enc_sender_addr_hash(SHARED_X);
    let enc_recipient_addr_hash = compute_enc_recipient_addr_hash(
        sender, SENDER_PRIVATE_KEY, INDEX, SALT.into(),
    );

    // Encryption outputs
    // Derive a real public key from a private key for ECDH tests
    let recipient_private_key: felt252 = 0x12345;
    let recipient_public_key_derived = derive_public_key(recipient_private_key);

    // Encrypt subchannel info
    let enc_subchannel = encrypt_subchannel_info(CHANNEL_KEY, INDEX, token, SALT.into());

    // Encrypt channel info (using derived public key for valid ECDH)
    let enc_channel = encrypt_channel_info(
        EPHEMERAL_SECRET, recipient_public_key_derived, CHANNEL_KEY, sender,
    );

    // Encrypt/decrypt note amount
    let enc_note_amount = encrypt_note_amount(CHANNEL_KEY, token, INDEX, SALT, AMOUNT);
    let dec_note_amount = decrypt_note_amount(enc_note_amount, CHANNEL_KEY, token, INDEX);

    // Print in format parseable by sdk/scripts/generate-cairo-refs.ts
    println!("=== CAIRO REFERENCE HASHES ===");

    // Inputs (source of truth)
    println!("inputs.sender: 0x{:x}", SENDER);
    println!("inputs.recipient: 0x{:x}", RECIPIENT);
    println!("inputs.senderPrivateKey: 0x{:x}", SENDER_PRIVATE_KEY);
    println!("inputs.recipientPublicKey: 0x{:x}", RECIPIENT_PUBLIC_KEY);
    println!("inputs.channelKey: 0x{:x}", CHANNEL_KEY);
    println!("inputs.token: 0x{:x}", TOKEN);
    println!("inputs.index: {}", INDEX);
    println!("inputs.salt: 0x{:x}", SALT);
    println!("inputs.sharedX: 0x{:x}", SHARED_X);
    println!("inputs.ephemeralSecret: 0x{:x}", EPHEMERAL_SECRET);
    println!("inputs.amount: {}", AMOUNT);
    println!("inputs.recipientPrivateKey: 0x{:x}", recipient_private_key);
    println!("inputs.recipientPublicKeyDerived: 0x{:x}", recipient_public_key_derived);

    // Outputs (computed hashes)
    println!("outputs.channelKey: 0x{:x}", channel_key);
    println!("outputs.channelId: 0x{:x}", channel_id);
    println!("outputs.subchannelKey: 0x{:x}", subchannel_key);
    println!("outputs.subchannelId: 0x{:x}", subchannel_id);
    println!("outputs.noteId: 0x{:x}", note_id);
    println!("outputs.nullifier: 0x{:x}", nullifier);
    println!("outputs.encAmountHash: 0x{:x}", enc_amount_hash);
    println!("outputs.encTokenHash: 0x{:x}", enc_token_hash);
    println!("outputs.encPrivateKeyHash: 0x{:x}", enc_private_key_hash);
    println!("outputs.encChannelKeyHash: 0x{:x}", enc_channel_key_hash);
    println!("outputs.encSenderAddrHash: 0x{:x}", enc_sender_addr_hash);
    println!("outputs.encRecipientAddrHash: 0x{:x}", enc_recipient_addr_hash);
    println!("outputs.outgoingChannelKey: 0x{:x}", outgoing_channel_key);

    // Encryption outputs
    println!("outputs.encSubchannelSalt: 0x{:x}", enc_subchannel.salt);
    println!("outputs.encSubchannelToken: 0x{:x}", enc_subchannel.enc_token);
    println!("outputs.encChannelEphemeralPubkey: 0x{:x}", enc_channel.ephemeral_pubkey);
    println!("outputs.encChannelKey: 0x{:x}", enc_channel.enc_channel_key);
    println!("outputs.encChannelSenderAddr: 0x{:x}", enc_channel.enc_sender_addr);
    println!("outputs.encNoteAmount: 0x{:x}", enc_note_amount);
    println!("outputs.decNoteAmount: {}", dec_note_amount);
    println!("==============================");
}

