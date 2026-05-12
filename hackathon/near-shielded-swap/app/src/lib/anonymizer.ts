// Off-chain replica of the `NearIntentsAnonymizer` Cairo helpers.
//
// Source of truth (must match byte-for-byte):
//   packages/near_intents_anonymizer/src/near_intents_anonymizer.cairo
//   - `OUTPUT_SALT_DOMAIN`, `REFUND_SALT_DOMAIN`, `CONTRACT_ADDRESS_PREFIX`
//   - `output_salt`, `refund_salt`, `hash_array`, `compute_address`
//   - `privacy_invoke(swap_id, asset_in, in_amount, asset_out,
//                     note_id_out, refund_note_id, deposit_address, note_id_unused)`
//
// Parity is pinned by Cairo tests in
// `packages/near_intents_anonymizer/src/tests/test_sdk_parity.cairo`.
import { hash, shortString } from "starknet";

// 2^251 + 17 * 2^192 + 1 — the Stark field prime is irrelevant here; we cap to
// the Starknet contract-address space, which is `[0, 2^251 - 256)`.
const ADDRESS_UPPER_BOUND = (1n << 251n) - 256n;

const OUTPUT_SALT_DOMAIN_FELT = shortString.encodeShortString("NIA_OUTPUT_V1");
const REFUND_SALT_DOMAIN_FELT = shortString.encodeShortString("NIA_REFUND_V1");
const CONTRACT_ADDRESS_PREFIX_FELT = shortString.encodeShortString(
  "STARKNET_CONTRACT_ADDRESS",
);

function toFeltString(value: bigint | string): string {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (value.startsWith("0x")) return value;
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * `hash_array([x0, x1, ..., x_{n-1}])` in Cairo terms — the length-suffixed
 * Pedersen chain that Starknet uses for address derivation and constructor
 * calldata hashing.
 */
export function hashArray(elements: readonly (bigint | string)[]): string {
  const felts = elements.map(toFeltString);
  return hash.computePedersenHashOnElements(felts);
}

export function outputSalt(swapId: bigint | string): string {
  return hash.computePedersenHash(
    OUTPUT_SALT_DOMAIN_FELT,
    toFeltString(swapId),
  );
}

export function refundSalt(swapId: bigint | string): string {
  return hash.computePedersenHash(
    REFUND_SALT_DOMAIN_FELT,
    toFeltString(swapId),
  );
}

/**
 * Mirror of Cairo `compute_address`. Returns the deterministic contract
 * address that `deploy_syscall(class_hash, salt, calldata, deploy_from_zero=false)`
 * would produce when invoked from `deployer`.
 */
export function computeContractAddress(args: {
  deployer: string;
  classHash: string;
  salt: string | bigint;
  ctorCalldataHash: string;
}): string {
  const h = hashArray([
    CONTRACT_ADDRESS_PREFIX_FELT,
    args.deployer,
    args.salt,
    args.classHash,
    args.ctorCalldataHash,
  ]);
  const folded = BigInt(h) % ADDRESS_UPPER_BOUND;
  return `0x${folded.toString(16).padStart(64, "0")}`;
}

interface AnonymizerConfig {
  anonymizerAddress: string;
  receiverClassHash: string;
}

/**
 * Precompute the constructor-calldata hash for all `MailboxReceiver` instances
 * deployed by `anonymizerAddress`. Cheap to cache — calldata is fixed
 * `[anonymizer_address]` for every receiver.
 */
export function receiverCtorHash(anonymizerAddress: string): string {
  return hashArray([anonymizerAddress]);
}

export function outputMailbox(
  config: AnonymizerConfig,
  swapId: bigint | string,
): string {
  return computeContractAddress({
    deployer: config.anonymizerAddress,
    classHash: config.receiverClassHash,
    salt: outputSalt(swapId),
    ctorCalldataHash: receiverCtorHash(config.anonymizerAddress),
  });
}

export function refundMailbox(
  config: AnonymizerConfig,
  swapId: bigint | string,
): string {
  return computeContractAddress({
    deployer: config.anonymizerAddress,
    classHash: config.receiverClassHash,
    salt: refundSalt(swapId),
    ctorCalldataHash: receiverCtorHash(config.anonymizerAddress),
  });
}

/**
 * Generate a fresh `swap_id` from the user's address + a session-unique nonce.
 * Must be non-zero and unique per swap (the anonymizer reverts on duplicates).
 */
export function newSwapId(userAddress: string, nonce: bigint | number): string {
  const noncedFelt = toFeltString(BigInt(nonce));
  return hash.computePedersenHash(toFeltString(userAddress), noncedFelt);
}

export interface PrivacyInvokeArgs {
  swapId: string;
  assetIn: string;
  inAmount: bigint;
  assetOut: string;
  noteIdOut: string;
  refundNoteId: string;
  depositAddress: string;
}

/** Serialize `privacy_invoke(...)` calldata. 8 felts in the order matched by
 *  `test_sdk_parity.cairo:fixture_privacy_invoke_calldata_layout`. */
export function privacyInvokeCalldata(args: PrivacyInvokeArgs): string[] {
  return [
    toFeltString(args.swapId),
    toFeltString(args.assetIn),
    toFeltString(args.inAmount),
    toFeltString(args.assetOut),
    toFeltString(args.noteIdOut),
    toFeltString(args.refundNoteId),
    toFeltString(args.depositAddress),
    "0x0", // note_id_unused per SDK convention
  ];
}

export function finalizeCalldata(swapId: string): string[] {
  return [toFeltString(swapId)];
}

export const recoverCalldata = finalizeCalldata;
