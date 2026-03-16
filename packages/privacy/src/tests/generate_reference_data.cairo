use core::poseidon::poseidon_hash_span;
/// Reference hash generator for TypeScript SDK compatibility testing.
///
/// This test is ignored by default. Run explicitly with:
///   snforge test generate_reference --include-ignored
///
/// The output should be used to update: sdk/tests/fixtures/cairo-reference-data.json
use privacy::actions::{ServerAction, WriteOnceInput};
use privacy::hashes::domain_separation::*;
use privacy::hashes::{
    compute_channel_key, compute_channel_marker, compute_enc_amount_hash,
    compute_enc_channel_key_hash, compute_enc_private_key_hash, compute_enc_recipient_addr_hash,
    compute_enc_sender_addr_hash, compute_enc_token_hash, compute_note_id, compute_nullifier,
    compute_outgoing_channel_id, compute_subchannel_id, compute_subchannel_marker,
};
use privacy::utils::constants::{VIRTUAL_SNOS, VIRTUAL_SNOS0};
use privacy::utils::{
    ProofFacts, decode_note_amount, derive_public_key, enc_note_packed_value, encrypt_channel_info,
    encrypt_outgoing_channel_info, encrypt_private_key, encrypt_subchannel_info, encrypt_user_addr,
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
const SALT: u128 = 0x5678;
const SHARED_X: felt252 = 0x9abc;
// Additional inputs for encryption tests
const EPHEMERAL_SECRET: felt252 = 0xabcd;
const AMOUNT: u128 = 1000;
const AUDITOR_PRIVATE_KEY: felt252 = 0x54321;
const USER_ADDR: felt252 = 0x999;
const USER_PRIVATE_KEY: felt252 = 0x888;

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
    let channel_marker = compute_channel_marker(
        CHANNEL_KEY, sender, recipient, RECIPIENT_PUBLIC_KEY,
    );
    let subchannel_id = compute_subchannel_id(CHANNEL_KEY, INDEX);
    let subchannel_marker = compute_subchannel_marker(
        CHANNEL_KEY, recipient, RECIPIENT_PUBLIC_KEY, token,
    );
    let note_id = compute_note_id(CHANNEL_KEY, token, INDEX);
    let nullifier = compute_nullifier(CHANNEL_KEY, token, INDEX, SENDER_PRIVATE_KEY);

    // Outgoing channel id
    let outgoing_channel_id = compute_outgoing_channel_id(sender, SENDER_PRIVATE_KEY, INDEX);

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

    // Encrypt/decode note amount
    let enc_note_amount = enc_note_packed_value(CHANNEL_KEY, token, INDEX, SALT, AMOUNT);
    let dec_note_amount = decode_note_amount(enc_note_amount, CHANNEL_KEY, token, INDEX);

    // Derive auditor public key for ECDH tests
    let auditor_public_key = derive_public_key(AUDITOR_PRIVATE_KEY);
    let user_addr = to_address(USER_ADDR);

    // Encrypt outgoing channel info
    let enc_outgoing = encrypt_outgoing_channel_info(
        sender, SENDER_PRIVATE_KEY, INDEX, recipient, SALT.into(),
    );

    // Encrypt private key (for auditor)
    let enc_private_key = encrypt_private_key(
        EPHEMERAL_SECRET, auditor_public_key, USER_PRIVATE_KEY,
    );

    // Encrypt user address (for auditor)
    let enc_user_addr = encrypt_user_addr(EPHEMERAL_SECRET, auditor_public_key, user_addr);

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
    println!("inputs.auditorPrivateKey: 0x{:x}", AUDITOR_PRIVATE_KEY);
    println!("inputs.auditorPublicKey: 0x{:x}", auditor_public_key);
    println!("inputs.userAddr: 0x{:x}", USER_ADDR);
    println!("inputs.userPrivateKey: 0x{:x}", USER_PRIVATE_KEY);

    // Outputs (computed hashes)
    println!("outputs.channelKey: 0x{:x}", channel_key);
    println!("outputs.channelMarker: 0x{:x}", channel_marker);
    println!("outputs.subchannelId: 0x{:x}", subchannel_id);
    println!("outputs.subchannelMarker: 0x{:x}", subchannel_marker);
    println!("outputs.noteId: 0x{:x}", note_id);
    println!("outputs.nullifier: 0x{:x}", nullifier);
    println!("outputs.encAmountHash: 0x{:x}", enc_amount_hash);
    println!("outputs.encTokenHash: 0x{:x}", enc_token_hash);
    println!("outputs.encPrivateKeyHash: 0x{:x}", enc_private_key_hash);
    println!("outputs.encChannelKeyHash: 0x{:x}", enc_channel_key_hash);
    println!("outputs.encSenderAddrHash: 0x{:x}", enc_sender_addr_hash);
    println!("outputs.encRecipientAddrHash: 0x{:x}", enc_recipient_addr_hash);
    println!("outputs.outgoingChannelId: 0x{:x}", outgoing_channel_id);

    // Encryption outputs
    println!("outputs.encSubchannelSalt: 0x{:x}", enc_subchannel.salt);
    println!("outputs.encSubchannelToken: 0x{:x}", enc_subchannel.enc_token);
    println!("outputs.encChannelEphemeralPubkey: 0x{:x}", enc_channel.ephemeral_pubkey);
    println!("outputs.encChannelKey: 0x{:x}", enc_channel.enc_channel_key);
    println!("outputs.encChannelSenderAddr: 0x{:x}", enc_channel.enc_sender_addr);
    println!("outputs.encNoteAmount: 0x{:x}", enc_note_amount);
    println!("outputs.decNoteAmount: {}", dec_note_amount);

    // Outgoing channel info outputs
    println!("outputs.encOutgoingSalt: 0x{:x}", enc_outgoing.salt);
    println!("outputs.encOutgoingRecipientAddr: 0x{:x}", enc_outgoing.enc_recipient_addr);

    // Encrypt private key outputs
    println!("outputs.encPrivateKeyEphemeralPubkey: 0x{:x}", enc_private_key.ephemeral_pubkey);
    println!("outputs.encPrivateKeyValue: 0x{:x}", enc_private_key.enc_private_key);

    // Encrypt user address outputs
    println!("outputs.encUserAddrEphemeralPubkey: 0x{:x}", enc_user_addr.ephemeral_pubkey);
    println!("outputs.encUserAddrValue: 0x{:x}", enc_user_addr.enc_user_addr);
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
fn generate_reference_storage_slots() {
    let sender = to_address(SENDER);
    let recipient = to_address(RECIPIENT);
    let token = to_address(TOKEN);

    // Compute hash values needed as keys
    let channel_marker = compute_channel_marker(
        CHANNEL_KEY, sender, recipient, RECIPIENT_PUBLIC_KEY,
    );
    let subchannel_id = compute_subchannel_id(CHANNEL_KEY, INDEX);
    let subchannel_marker = compute_subchannel_marker(
        CHANNEL_KEY, recipient, RECIPIENT_PUBLIC_KEY, token,
    );
    let note_id = compute_note_id(CHANNEL_KEY, token, INDEX);
    let nullifier = compute_nullifier(CHANNEL_KEY, token, INDEX, SENDER_PRIVATE_KEY);

    println!("=== STORAGE SLOTS ===");
    // Formula for maps: address = pedersen(sn_keccak(variable_name), key) mod (2^251 - 256)
    // Formula for simple vars: address = sn_keccak(variable_name)

    // --- Simple variables ---
    // auditor_public_key - felt252 (simple variable, address = sn_keccak(name))
    let auditor_public_key_slot = selector!("auditor_public_key");

    // public_key[user_addr] - Map<ContractAddress, felt252>
    let public_key_slot = map_entry_address(
        map_selector: selector!("public_key"), keys: [SENDER].span(),
    );

    // public_key[recipient_addr] - verification read
    let recipient_public_key_slot = map_entry_address(
        map_selector: selector!("public_key"), keys: [RECIPIENT].span(),
    );

    // enc_private_key[user_addr] - Map<ContractAddress, EncPrivateKey>
    // EncPrivateKey is a struct with 3 fields stored at consecutive addresses:
    // auditor_public_key, ephemeral_pubkey, enc_private_key
    let enc_private_key_slot = map_entry_address(
        map_selector: selector!("enc_private_key"), keys: [SENDER].span(),
    );

    // channel_exists[channel_marker] - Map<felt252, bool>
    let channel_exists_slot = map_entry_address(
        map_selector: selector!("channel_exists"), keys: [channel_marker].span(),
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

    // subchannel_exists[subchannel_marker] - Map<felt252, bool>
    let subchannel_exists_slot = map_entry_address(
        map_selector: selector!("subchannel_exists"), keys: [subchannel_marker].span(),
    );

    // subchannel_tokens[subchannel_id] - Map<felt252, EncSubchannelInfo>
    // EncSubchannelInfo is a struct with 2 fields stored at consecutive addresses
    let subchannel_tokens_slot = map_entry_address(
        map_selector: selector!("subchannel_tokens"), keys: [subchannel_id].span(),
    );

    // notes[note_id] - Map<felt252, felt252>
    let notes_slot = map_entry_address(map_selector: selector!("notes"), keys: [note_id].span());

    // nullifiers[nullifier] - Map<felt252, bool>
    let nullifiers_slot = map_entry_address(
        map_selector: selector!("nullifiers"), keys: [nullifier].span(),
    );

    // Flat output for discovery-core compatibility
    println!("slots.auditorPublicKeyAddress: 0x{:x}", auditor_public_key_slot);
    println!("slots.senderPublicKeyAddress: 0x{:x}", public_key_slot);
    println!("slots.recipientPublicKeyAddress: 0x{:x}", recipient_public_key_slot);
    println!("slots.encPrivateKeyAuditorPubKeyAddress: 0x{:x}", enc_private_key_slot);
    println!("slots.encPrivateKeyEphemeralAddress: 0x{:x}", enc_private_key_slot + 1);
    println!("slots.encPrivateKeyEncKeyAddress: 0x{:x}", enc_private_key_slot + 2);
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
    println!("inputs.channelMarker: 0x{:x}", channel_marker);
    println!("inputs.subchannelId: 0x{:x}", subchannel_id);
    println!("inputs.subchannelMarker: 0x{:x}", subchannel_marker);
    println!("inputs.noteId: 0x{:x}", note_id);
    println!("inputs.nullifier: 0x{:x}", nullifier);

    println!("==============================");
}

/// ProofFacts test vector generator for TypeScript SDK compatibility testing.
///
/// This test produces the serialized ProofFacts and message hash that the
/// contract's `validate_proof` expects, using known inputs. The TypeScript
/// `buildProofFacts` function must produce identical output.
///
/// Run explicitly with:
///   snforge test generate_reference_proof_facts --include-ignored
#[test]
#[ignore]
fn generate_reference_proof_facts() {
    // Known inputs
    let pool_address: felt252 = 0xABCDE;
    let pool_class_hash: felt252 =
        0x12345; // Reference value for fixture; discovery-core may use for slot derivation
    let base_block_number: u64 = 100;

    // Build a minimal set of server actions with known serialization.
    // WriteOnce is variant index 0 in the ServerAction enum.
    let actions: Span<ServerAction> = [
        ServerAction::WriteOnce(
            WriteOnceInput { storage_address: 0x111, value: [0x222, 0x333].span() },
        ),
    ]
        .span();

    // Serialize actions the same way validate_proof does
    let mut serialized_actions = array![];
    actions.serialize(ref serialized_actions);

    // Compute message hash with fixed pool_class_hash so the reference matches the SDK
    // (production compute_message_hash uses get_class_hash_at_syscall(contract_address))
    let mut l1_message_data: Array<felt252> = array![pool_address, 0];
    let mut payload = array![];
    pool_class_hash.serialize(ref payload);
    actions.serialize(ref payload);
    payload.serialize(ref l1_message_data);
    let message_hash = poseidon_hash_span(l1_message_data.span());

    // Build the full ProofFacts struct
    let proof_facts = ProofFacts {
        proof_version: 0,
        program_variant: VIRTUAL_SNOS,
        virtual_program_hash: 0,
        starknet_os_output_version: VIRTUAL_SNOS0,
        base_block_number,
        base_block_hash: 0,
        starknet_os_config_hash: 0,
        message_to_l1_hashes: [message_hash].span(),
    };

    // Serialize the full ProofFacts struct
    let mut serialized_proof_facts = array![];
    proof_facts.serialize(ref serialized_proof_facts);

    println!("=== PROOF FACTS ===");

    // Inputs
    println!("proofFacts.poolAddress: 0x{:x}", pool_address);
    println!("proofFacts.poolClassHash: 0x{:x}", pool_class_hash);
    println!("proofFacts.baseBlockNumber: {}", base_block_number);

    // The serialized server actions (this is what proof.output contains in TS)
    println!("proofFacts.serializedActionsLength: {}", serialized_actions.len());
    let mut action_index = 0;
    for felt in serialized_actions {
        println!("proofFacts.serializedActions.{}: 0x{:x}", action_index, felt);
        action_index += 1;
    }

    // The message hash
    println!("proofFacts.messageHash: 0x{:x}", message_hash);

    // The full serialized proof facts
    println!("proofFacts.serializedLength: {}", serialized_proof_facts.len());
    let mut proof_index = 0;
    for felt in serialized_proof_facts {
        println!("proofFacts.serialized.{}: 0x{:x}", proof_index, felt);
        proof_index += 1;
    }

    // The full L2-to-L1 message payload: [class_hash, ...serialized_actions]
    println!("proofFacts.messagePayloadLength: {}", payload.len());
    let mut payload_index = 0;
    for felt in payload {
        println!("proofFacts.messagePayload.{}: 0x{:x}", payload_index, felt);
        payload_index += 1;
    }

    // Also print the constants for verification
    println!("proofFacts.virtualSnos: 0x{:x}", VIRTUAL_SNOS);
    println!("proofFacts.virtualSnos0: 0x{:x}", VIRTUAL_SNOS0);

    println!("==============================");
}
