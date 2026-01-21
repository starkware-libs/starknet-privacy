/// Reference data generator for TypeScript SDK and Discovery Service compatibility testing.
///
/// This test is ignored by default. Run explicitly with:
///   snforge test generate_reference_data --include-ignored
///
/// The output should be used to update: sdk/tests/fixtures/cairo-reference-data.json
use privacy::hashes::{
    compute_channel_id, compute_channel_key, compute_note_id, compute_nullifier,
    compute_subchannel_id, compute_subchannel_key, domain_separation::*,
};
use snforge_std::map_entry_address;
use starknet::ContractAddress;

// Test inputs - must match sdk/tests/fixtures/cairo-reference-data.json
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

/// Storage slot test vector generator for discovery service compatibility testing.
///
/// This test is ignored by default. Run explicitly with:
///   snforge test generate_storage_slots --include-ignored
///
/// The output provides test vectors allowing the discovery service to verify their
/// storage address computation implementation.
///
/// Storage address formula for Map<K, V>:
///   address = pedersen(sn_keccak(variable_name), key) mod (2^251 - 256)
/// where sn_keccak is keccak256 truncated to 250 bits.
#[test]
#[ignore]
fn generate_storage_slots() {
    let sender = to_address(SENDER);
    let recipient = to_address(RECIPIENT);
    let token = to_address(TOKEN);

    // Compute hash values needed as keys
    let channel_id = compute_channel_id(CHANNEL_KEY, sender, recipient, RECIPIENT_PUBLIC_KEY);
    let subchannel_key = compute_subchannel_key(CHANNEL_KEY, INDEX);
    let subchannel_id = compute_subchannel_id(CHANNEL_KEY, recipient, RECIPIENT_PUBLIC_KEY, token);
    let note_id = compute_note_id(CHANNEL_KEY, token, INDEX);
    let nullifier = compute_nullifier(CHANNEL_KEY, token, INDEX, SENDER_PRIVATE_KEY);

    println!("=== STORAGE SLOTS ===");
    // Formula for maps: address = pedersen(sn_keccak(variable_name), key) mod (2^251 - 256)
    // Formula for simple vars: address = sn_keccak(variable_name)

    // --- Simple variables ---
    // compliance_public_key - felt252 (simple variable, address = sn_keccak(name))
    let compliance_public_key_slot = selector!("compliance_public_key");

    // public_key[user_addr] - Map<ContractAddress, felt252>
    let public_key_slot = map_entry_address(
        map_selector: selector!("public_key"), keys: [SENDER].span(),
    );

    // public_key[recipient_addr] - verification read
    let recipient_public_key_slot = map_entry_address(
        map_selector: selector!("public_key"), keys: [RECIPIENT].span(),
    );

    // enc_private_key[user_addr] - Map<ContractAddress, EncPrivateKey>
    // EncPrivateKey is a struct with 2 fields stored at consecutive addresses
    let enc_private_key_slot = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [SENDER].span(),
    );

    // channel_exists[channel_id] - Map<felt252, bool>
    let channel_exists_slot = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_id].span(),
    );

    // recipient_channels[recipient_addr] - Vec<EncChannelInfo>
    // Vec base address stores the length
    let recipient_channels_base = map_entry_address(
        map_selector: selector!("recipient_channels"), keys: [RECIPIENT].span(),
    );
    // Vec element address: pedersen(base_address, index)
    let vec_index: felt252 = 0;
    let recipient_channels_element = map_entry_address(
        map_selector: recipient_channels_base, keys: [vec_index].span(),
    );

    // subchannel_exists[subchannel_id] - Map<felt252, bool>
    let subchannel_exists_slot = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_id].span(),
    );

    // subchannel_tokens[subchannel_key] - Map<felt252, EncSubchannelInfo>
    // EncSubchannelInfo is a struct with 2 fields stored at consecutive addresses
    let subchannel_tokens_slot = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_key].span(),
    );

    // notes[note_id] - Map<felt252, felt252>
    let notes_slot = map_entry_address(map_selector: selector!("notes"), keys: [note_id].span());

    // nullifiers[nullifier] - Map<felt252, bool>
    let nullifiers_slot = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );

    // Flat output for discovery-core compatibility
    println!("slots.compliancePublicKeyAddress: 0x{:x}", compliance_public_key_slot);
    println!("slots.senderPublicKeyAddress: 0x{:x}", public_key_slot);
    println!("slots.recipientPublicKeyAddress: 0x{:x}", recipient_public_key_slot);
    println!("slots.encPrivateKeyEphemeralAddress: 0x{:x}", enc_private_key_slot);
    println!("slots.encPrivateKeyEncKeyAddress: 0x{:x}", enc_private_key_slot + 1);
    println!("slots.channelExistsAddress: 0x{:x}", channel_exists_slot);
    println!("slots.recipientChannelsBaseAddress: 0x{:x}", recipient_channels_base);
    println!("slots.recipientChannelsElementAddress: 0x{:x}", recipient_channels_element);
    println!("slots.subchannelExistsAddress: 0x{:x}", subchannel_exists_slot);
    println!("slots.subchannelTokensSaltAddress: 0x{:x}", subchannel_tokens_slot);
    println!("slots.subchannelTokensEncTokenAddress: 0x{:x}", subchannel_tokens_slot + 1);
    println!("slots.notesAddress: 0x{:x}", notes_slot);
    println!("slots.nullifiersAddress: 0x{:x}", nullifiers_slot);

    // Inputs used for key computation
    println!("inputs.sender: 0x{:x}", SENDER);
    println!("inputs.recipient: 0x{:x}", RECIPIENT);
    println!("inputs.channelId: 0x{:x}", channel_id);
    println!("inputs.subchannelKey: 0x{:x}", subchannel_key);
    println!("inputs.subchannelId: 0x{:x}", subchannel_id);
    println!("inputs.noteId: 0x{:x}", note_id);
    println!("inputs.nullifier: 0x{:x}", nullifier);

    println!("==============================");
}
