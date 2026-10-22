/**
 * Builds the ProofFacts serialization matching both the blockifier and Cairo contract.
 *
 * The blockifier validates the first two fields as a version+variant header.
 * The Cairo contract deserializes the same array via Serde into ProofFacts struct.
 *
 * Blockifier checks, in `AccountTransaction::validate_proof_facts` (account_transaction.rs:291),
 * against the versioned constants of the block the transaction lands in. It runs in
 * `perform_pre_validation_stage` (account_transaction.rs:355), which neither SKIP_VALIDATE nor
 * SKIP_FEE_CHARGE turns off, so simulation enforces it too. STARK verification happens in the
 * gateway, not here, which is why mock facts can be simulated.
 * Source: https://github.com/starkware-libs/sequencer/blob/603f1bd8dca9da4c37b75841bf322bfa9d032d12/crates/blockifier/src/transaction/account_transaction.rs
 * 1. `proof_facts[0]` is in `allowed_proof_versions`
 * 2. `proof_facts[1] == VIRTUAL_SNOS`
 * 3. `proof_facts[2]` is in `allowed_virtual_os_program_hashes`
 * 4. `proof_facts[3] == VIRTUAL_OS_OUTPUT_VERSION` ('VIRTUAL_SNOS0')
 * 5. `proof_facts[4]` is at most `current_block - STORED_BLOCK_HASH_BUFFER` (line 238), and
 *    `proof_facts[5]` is non-zero and equals that block's stored hash (line 262)
 * 6. `proof_facts[6]` equals `block_context.virtual_os_config_hash()` (line 341)
 *
 * Cairo contract `validate_proof` checks:
 * 1. `program_variant == 'VIRTUAL_SNOS'`
 * 2. `starknet_os_output_version == 'VIRTUAL_SNOS0'`
 * 3. `base_block_number` within PROOF_VALIDITY_BLOCK_INTERVAL of current block
 * 4. `message_to_l1_hashes == [poseidon(pool_addr, 0, payload_len, ...serialized_server_actions)]`
 */

import { compareVersions, ec, hash } from "starknet";
import { shortStringToFelt } from "./crypto.js";
import { toBigInt, toHex } from "./convert.js";
import type { BigNumberish } from "starknet";

const VIRTUAL_SNOS = shortStringToFelt("VIRTUAL_SNOS");
const VIRTUAL_SNOS0 = shortStringToFelt("VIRTUAL_SNOS0");

// STRK fee token address — same on all Starknet networks (mainnet, sepolia, devnet).
const STRK_FEE_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

/** The Starknet version proof facts target when the caller names none. */
export const DEFAULT_PROOF_FACTS_STARKNET_VERSION = "0.14.4";

/**
 * Protocol-dependent proof facts fields. Each override replaces the value the target
 * `starknetVersion` implies, so callers can track a protocol upgrade without an SDK release.
 */
export type ProofFactsConfig = {
  /**
   * Starknet version of the network the proof is submitted to; selects the defaults below.
   * Default: {@link DEFAULT_PROOF_FACTS_STARKNET_VERSION}. Versions before 0.14.3 select the 0.14.2
   * protocol (PROOF0, Pedersen config hash), which is what devnet v0.8 runs.
   */
  starknetVersion?: string;
  /** `proof_facts[0]`; must be in the network's `allowed_proof_versions`. */
  proofVersion?: BigNumberish;
  /** `proof_facts[2]`; must be in the network's `allowed_virtual_os_program_hashes`. */
  virtualProgramHash?: BigNumberish;
  /** `proof_facts[6]`; replaces the config hash computed from the chain id. */
  osConfigHash?: BigNumberish;
};

type ProtocolProofFacts = {
  proofVersion: bigint;
  virtualProgramHash: string;
  computeOsConfigHash: (chainId: BigNumberish) => string;
};

// Source: https://github.com/starkware-libs/sequencer/blob/586b07b38d87f608b632e5795071d31317faf6c4/crates/blockifier/resources/blockifier_versioned_constants_0_14_2.json
// and crates/starknet_api/src/core.rs at the same commit.
const PROTOCOL_V0_14_2: ProtocolProofFacts = {
  proofVersion: shortStringToFelt("PROOF0"),
  virtualProgramHash: "0x3e98c2d7703b03a7edb73ed7f075f97f1dcbaa8f717cdf6e1a57bf058265473",
  // Pedersen::hash_array(['StarknetOsConfig3', chain_id, strk_fee_token_address])
  computeOsConfigHash: (chainId) =>
    hash.computeHashOnElements([
      shortStringToFelt("StarknetOsConfig3"),
      chainId,
      STRK_FEE_TOKEN_ADDRESS,
    ]),
};

// os_constants.allowed_proof_versions / allowed_virtual_os_program_hashes, first entry of each (the
// only one 0.14.3 also allows; 0.14.4 additionally allows PROOF2 and 0x1c7be322...).
// Source: https://github.com/starkware-libs/sequencer/blob/603f1bd8dca9da4c37b75841bf322bfa9d032d12/crates/blockifier/resources/blockifier_versioned_constants_0_14_4.json
const PROTOCOL_V0_14_4: ProtocolProofFacts = {
  proofVersion: shortStringToFelt("PROOF1"),
  virtualProgramHash: "0x53f6c9fcfd31d27279ff7d7e422b44623550a732b59fe193354a7316a96daa1",
  // From 0.14.3 (OS_CONFIG_HASH_V4_CUTOVER) OsChainInfo::compute_virtual_os_config_hash is
  // Blake2Felt252::encode_felt252_data_and_calc_blake_hash(['StarknetOsConfig4', chain_id,
  // strk_fee_token_address]).
  // Source: https://github.com/starkware-libs/sequencer/blob/603f1bd8dca9da4c37b75841bf322bfa9d032d12/crates/starknet_api/src/core.rs
  computeOsConfigHash: (chainId) =>
    toHex(
      hash.blake2sHashMany([
        shortStringToFelt("StarknetOsConfig4"),
        toBigInt(chainId),
        toBigInt(STRK_FEE_TOKEN_ADDRESS),
      ])
    ),
};

function protocolProofFacts(starknetVersion: string): ProtocolProofFacts {
  return compareVersions(starknetVersion, "0.14.3") < 0 ? PROTOCOL_V0_14_2 : PROTOCOL_V0_14_4;
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
 *   [0] proof_version: felt252          → proofVersion ('PROOF1')
 *   [1] program_variant: felt252        → VIRTUAL_SNOS
 *   [2] virtual_program_hash: felt252   → virtualProgramHash
 *   [3] starknet_os_output_version      → VIRTUAL_SNOS0
 *   [4] base_block_number: u64          → blockNumber
 *   [5] base_block_hash: felt252        → blockHash
 *   [6] starknet_os_config_hash: felt252 → osConfigHash, by default Blake(version, chain_id, strk_token)
 *   [7] message_to_l1_hashes length     → 1 (Span serialization)
 *   [8] message_to_l1_hashes[0]         → poseidon(pool_addr, 0, payload_len, ...actions)
 *
 * `config` selects the protocol fields; see {@link ProofFactsConfig}.
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
  const protocol = protocolProofFacts(
    config.starknetVersion ?? DEFAULT_PROOF_FACTS_STARKNET_VERSION
  );
  const messageHash = computeMessageHash(poolAddress, poolClassHash, serverActionsCalldata);
  const configHash = config.osConfigHash ?? protocol.computeOsConfigHash(chainId);
  return [
    toHex(config.proofVersion ?? protocol.proofVersion), // proof_version
    `0x${VIRTUAL_SNOS.toString(16)}`, // program_variant
    toHex(config.virtualProgramHash ?? protocol.virtualProgramHash), // virtual_program_hash
    `0x${VIRTUAL_SNOS0.toString(16)}`, // starknet_os_output_version
    `0x${blockNumber.toString(16)}`, // base_block_number
    `0x${toBigInt(blockHash).toString(16)}`, // base_block_hash
    toHex(configHash), // starknet_os_config_hash
    "0x1", // message_to_l1_hashes length (Span serialization)
    `0x${messageHash.toString(16)}`, // message_to_l1_hashes[0]
  ];
}
