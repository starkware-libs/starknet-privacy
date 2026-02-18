/**
 * Builds the ProofFacts serialization matching both the blockifier and Cairo contract.
 *
 * The blockifier validates the first two fields as a version+variant header.
 * The Cairo contract deserializes the same array via Serde into ProofFacts struct.
 *
 * Blockifier checks:
 * 1. `proof_facts[0] == PROOF_VERSION` ('PROOF0')
 * 2. `proof_facts[1] == VIRTUAL_SNOS`
 * 3. `proof_facts[3] == VIRTUAL_OS_OUTPUT_VERSION` ('VIRTUAL_SNOS0')
 *
 * Cairo contract `validate_proof` checks:
 * 1. `program_variant == 'VIRTUAL_SNOS'`
 * 2. `starknet_os_output_version == 'VIRTUAL_SNOS0'`
 * 3. `base_block_number` within PROOF_VALIDITY_BLOCK_INTERVAL of current block
 * 4. `message_to_l1_hashes == [poseidon(pool_addr, 0, payload_len, ...serialized_server_actions)]`
 */

import { ec, hash } from "starknet";
import { shortStringToFelt } from "./crypto.js";
import { toBigInt } from "./convert.js";
import type { BigNumberish } from "starknet";

// Protocol constants - must match proving service for proofs to validate on L1
export const PROOF_VERSION = shortStringToFelt("PROOF0");
export const VIRTUAL_SNOS = shortStringToFelt("VIRTUAL_SNOS");
export const VIRTUAL_SNOS0 = shortStringToFelt("VIRTUAL_SNOS0");

// Allowed virtual OS program hash from blockifier versioned constants.
// Source: https://github.com/starkware-libs/sequencer/blob/586b07b38d87f608b632e5795071d31317faf6c4/crates/blockifier/resources/blockifier_versioned_constants_0_14_2.json
export const VIRTUAL_PROGRAM_HASH = "0x6972cfa5c07f702981678547574e239a24ad8bb53cc081ad738ccb10839fd1a";

// STRK fee token address — same on all Starknet networks (mainnet, sepolia, devnet).
const STRK_FEE_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// STARKNET_OS_CONFIG_HASH_VERSION = shortString("StarknetOsConfig3")
// Source: https://github.com/starkware-libs/sequencer/blob/586b07b38d87f608b632e5795071d31317faf6c4/crates/starknet_api/src/core.rs
const STARKNET_OS_CONFIG_HASH_VERSION = "0x537461726b6e65744f73436f6e66696733";

/**
 * Compute the virtual OS config hash matching blockifier's OsChainInfo::compute_virtual_os_config_hash:
 *   Pedersen::hash_array([STARKNET_OS_CONFIG_HASH_VERSION, chain_id, strk_fee_token_address])
 */
function computeVirtualOsConfigHash(
  chainId: BigNumberish,
  strkFeeTokenAddress: BigNumberish
): string {
  return hash.computeHashOnElements([
    STARKNET_OS_CONFIG_HASH_VERSION,
    chainId,
    strkFeeTokenAddress,
  ]);
}

/**
 * Compute the message hash matching Cairo's _compute_message_hash:
 *   `hash([contract_address, 0, payload_len, ...serialized_actions])`
 * where hash = poseidon_hash_span.
 */
function computeMessageHash(
  poolAddress: BigNumberish,
  poolClassHash: BigNumberish,
  serverActionsCalldata: string[]
): bigint {
  const payloadLen = BigInt(serverActionsCalldata.length + 1);
  const feltValues = [
    toBigInt(poolAddress),
    0n,
    payloadLen,
    toBigInt(poolClassHash),
    ...serverActionsCalldata.map(toBigInt),
  ];
  return ec.starkCurve.poseidonHashMany(feltValues);
}

/**
 * Build the ProofFacts array matching both blockifier wire format and Cairo Serde layout.
 *
 * Layout (shared by blockifier and Cairo Serde):
 *   [0] proof_version: felt252          → PROOF_VERSION ('PROOF0')
 *   [1] program_variant: felt252        → VIRTUAL_SNOS
 *   [2] virtual_program_hash: felt252   → VIRTUAL_PROGRAM_HASH
 *   [3] starknet_os_output_version      → VIRTUAL_SNOS0
 *   [4] base_block_number: u64          → blockNumber
 *   [5] base_block_hash: felt252        → blockHash
 *   [6] starknet_os_config_hash: felt252 → Pedersen(version, chain_id, strk_token)
 *   [7] message_to_l1_hashes length     → 1 (Span serialization)
 *   [8] message_to_l1_hashes[0]         → poseidon(pool_addr, 0, payload_len, ...actions)
 */
export function buildProofFacts(
  poolAddress: BigNumberish,
  poolClassHash: BigNumberish,
  serverActionsCalldata: string[],
  blockNumber: bigint,
  blockHash: BigNumberish,
  chainId: BigNumberish
): string[] {
  const messageHash = computeMessageHash(poolAddress, poolClassHash, serverActionsCalldata);
  const configHash = computeVirtualOsConfigHash(chainId, STRK_FEE_TOKEN_ADDRESS);
  return [
    `0x${PROOF_VERSION.toString(16)}`, // proof_version ('PROOF0')
    `0x${VIRTUAL_SNOS.toString(16)}`, // program_variant
    VIRTUAL_PROGRAM_HASH, // virtual_program_hash
    `0x${VIRTUAL_SNOS0.toString(16)}`, // starknet_os_output_version
    `0x${blockNumber.toString(16)}`, // base_block_number
    `0x${toBigInt(blockHash).toString(16)}`, // base_block_hash
    configHash, // starknet_os_config_hash
    "0x1", // message_to_l1_hashes length (Span serialization)
    `0x${messageHash.toString(16)}`, // message_to_l1_hashes[0]
  ];
}
