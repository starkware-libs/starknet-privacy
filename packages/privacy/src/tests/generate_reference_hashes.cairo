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
// Inputs (source of truth)
// Outputs (computed hashes)
}

