/// Reference hash generator for TypeScript SDK compatibility testing.
///
/// This test is ignored by default. Run explicitly with:
///   snforge test generate_reference_hashes --include-ignored
///
/// The output should be used to update: sdk/tests/fixtures/cairo-reference-hashes.json
use privacy::hashes::{
    compute_channel_id, compute_channel_key, compute_note_id, compute_nullifier,
    compute_subchannel_id, compute_subchannel_key, domain_separation::*,
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

    // Outputs (computed hashes)
    println!("outputs.channelKey: 0x{:x}", channel_key);
    println!("outputs.channelId: 0x{:x}", channel_id);
    println!("outputs.subchannelKey: 0x{:x}", subchannel_key);
    println!("outputs.subchannelId: 0x{:x}", subchannel_id);
    println!("outputs.noteId: 0x{:x}", note_id);
    println!("outputs.nullifier: 0x{:x}", nullifier);
    println!("==============================");
}

