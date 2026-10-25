/**
 * Builds the ProofFacts serialization matching both the blockifier and Cairo contract.
 *
 * The Cairo contract deserializes the same array via Serde into ProofFacts struct.
 *
 * Blockifier checks (sequencer 603f1bd, starknet_api fields.rs / blockifier account_transaction.rs):
 * 1. `proof_facts[0]` is a known marker (PROOF0/1/2, fields.rs:757) and is in
 *    `allowed_proof_versions` (account_transaction.rs:314)
 * 2. `proof_facts[1] == VIRTUAL_SNOS` (fields.rs:768)
 * 3. `proof_facts[3] == VIRTUAL_OS_OUTPUT_VERSION` ('VIRTUAL_SNOS0', fields.rs:787)
 * 4. `proof_facts[2]` is in `allowed_virtual_os_program_hashes` (account_transaction.rs:324)
 * 5. `proof_facts[4] <= current_block - STORED_BLOCK_HASH_BUFFER` (10, account_transaction.rs:238)
 * 6. `proof_facts[5]` is non-zero and equals the stored block hash (account_transaction.rs:262)
 * 7. `proof_facts[6] == block_context.virtual_os_config_hash()` (account_transaction.rs:341)
 *
 * Cairo contract `validate_proof` checks:
 * 1. `program_variant == 'VIRTUAL_SNOS'`
 * 2. `starknet_os_output_version == 'VIRTUAL_SNOS0'`
 * 3. `base_block_number` within PROOF_VALIDITY_BLOCK_INTERVAL of current block
 * 4. `message_to_l1_hashes == [poseidon(pool_addr, 0, payload_len, ...serialized_server_actions)]`
 */

import { ec, hash } from "starknet";
import { shortStringToFelt } from "./crypto.js";
import { toBigInt, toHex } from "./convert.js";
import type { BigNumberish } from "starknet";

const VIRTUAL_SNOS = shortStringToFelt("VIRTUAL_SNOS");
const VIRTUAL_SNOS0 = shortStringToFelt("VIRTUAL_SNOS0");

// Allowed proof version and virtual OS program hash from blockifier versioned constants.
// PROOF2 is accepted by both mainnet and devnet v0.10 (whose 0.14.4 constants allow only PROOF2).
// Source: https://github.com/starkware-libs/sequencer/blob/603f1bd8dca9da4c37b75841bf322bfa9d032d12/crates/blockifier/resources/blockifier_versioned_constants_0_14_4.json
const PROOF_VERSION = shortStringToFelt("PROOF2");
const VIRTUAL_PROGRAM_HASH = "0x53f6c9fcfd31d27279ff7d7e422b44623550a732b59fe193354a7316a96daa1";

// STRK fee token address — same on all Starknet networks (mainnet, sepolia, devnet).
const STRK_FEE_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// STARKNET_OS_CONFIG_HASH_VERSION_V4 = shortString("StarknetOsConfig4")
// Source: https://github.com/starkware-libs/sequencer/blob/603f1bd8dca9da4c37b75841bf322bfa9d032d12/crates/starknet_api/src/core.rs
const STARKNET_OS_CONFIG_HASH_VERSION = "0x537461726b6e65744f73436f6e66696734";

/** Overrides for the protocol-dependent proof facts fields, e.g. after a protocol upgrade. */
export type ProofFactsConfig = {
  proofVersion?: BigNumberish;
  virtualProgramHash?: BigNumberish;
  osConfigHash?: BigNumberish;
};

/**
 * Compute the virtual OS config hash matching blockifier's OsChainInfo::compute_virtual_os_config_hash:
 *   Blake2Felt252([STARKNET_OS_CONFIG_HASH_VERSION, chain_id, strk_fee_token_address])
 */
function computeVirtualOsConfigHash(chainId: BigNumberish): bigint {
  return hash.blake2sHashMany([
    toBigInt(STARKNET_OS_CONFIG_HASH_VERSION),
    toBigInt(chainId),
    toBigInt(STRK_FEE_TOKEN_ADDRESS),
  ]);
}

/**
 * Compute the message hash matching Cairo's _compute_message_hash:
 *   `poseidon([pool_address, 0, payload_len, class_hash, ...serialized_actions])`
 */
function computeMessageHash(
  poolAddress: BigNumberish,
  poolClassHash: BigNumberish,
  serverActionsCalldata: string[]
): bigint {
  const messagePayload = buildMessagePayload(poolClassHash, serverActionsCalldata);
  const feltValues = [
    toBigInt(poolAddress),
    0n,
    BigInt(messagePayload.length),
    ...messagePayload.map(toBigInt),
  ];
  return ec.starkCurve.poseidonHashMany(feltValues);
}

/**
 * Build the L2-to-L1 message payload matching Cairo's compute_message_hash:
 *   `[class_hash, ...serialized_actions]`
 *
 * This is what the proving service returns in the L2-to-L1 message payload,
 * and what the message hash is computed over (after prepending pool_addr, 0, payload_len).
 */
export function buildMessagePayload(
  poolClassHash: BigNumberish,
  serverActionsCalldata: string[]
): string[] {
  return [toHex(poolClassHash), ...serverActionsCalldata];
}

/**
 * Build the ProofFacts array matching both blockifier wire format and Cairo Serde layout.
 *
 * Layout (shared by blockifier and Cairo Serde):
 *   [0] proof_version: felt252          → PROOF_VERSION ('PROOF2')
 *   [1] program_variant: felt252        → VIRTUAL_SNOS
 *   [2] virtual_program_hash: felt252   → VIRTUAL_PROGRAM_HASH
 *   [3] starknet_os_output_version      → VIRTUAL_SNOS0
 *   [4] base_block_number: u64          → blockNumber
 *   [5] base_block_hash: felt252        → blockHash
 *   [6] starknet_os_config_hash: felt252 → Blake(version, chain_id, strk_token)
 *   [7] message_to_l1_hashes length     → 1 (Span serialization)
 *   [8] message_to_l1_hashes[0]         → poseidon(pool_addr, 0, payload_len, ...actions)
 */
export function buildProofFacts(
  poolAddress: BigNumberish,
  poolClassHash: BigNumberish,
  serverActionsCalldata: string[],
  blockNumber: bigint,
  blockHash: BigNumberish,
  chainId: BigNumberish,
  config: ProofFactsConfig = {}
): string[] {
  const messageHash = computeMessageHash(poolAddress, poolClassHash, serverActionsCalldata);
  return [
    toHex(config.proofVersion ?? PROOF_VERSION), // proof_version
    `0x${VIRTUAL_SNOS.toString(16)}`, // program_variant
    toHex(config.virtualProgramHash ?? VIRTUAL_PROGRAM_HASH), // virtual_program_hash
    `0x${VIRTUAL_SNOS0.toString(16)}`, // starknet_os_output_version
    `0x${blockNumber.toString(16)}`, // base_block_number
    `0x${toBigInt(blockHash).toString(16)}`, // base_block_hash
    toHex(config.osConfigHash ?? computeVirtualOsConfigHash(chainId)), // starknet_os_config_hash
    "0x1", // message_to_l1_hashes length (Span serialization)
    `0x${messageHash.toString(16)}`, // message_to_l1_hashes[0]
  ];
}
