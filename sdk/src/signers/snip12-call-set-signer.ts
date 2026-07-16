/**
 * SNIP-12 `CallSet` signer ("Legacy" SN wallets, e.g. Fordefi).
 *
 * A `SignerInterface` whose `signTransaction` authorizes the account's invocation (any operation —
 * deposit / transfer / withdraw / setup …) by signing the SNIP-12 (revision 1) `CallSet` message the
 * privacy pool verifies on-chain — NOT the synthetic proving transaction (a wallet won't sign that).
 * See the README "Account signers (native-wallet support)" section. The pool's OR-fallback checks
 * `is_valid_signature(compute_call_set_hash(account, calls), sig)`
 * (packages/privacy/src/snip12.cairo), so the hash here is byte-compatible with that Cairo function.
 *
 * The message hash is built with direct `poseidonHashMany` (like the screening signer), deliberately
 * NOT via starknet.js `typedData.getMessageHash`: the SNIP-12 domain `version` is the numeric felt
 * `1` (the on-chain verifier's convention), whereas typed-data encoding would treat the declared
 * `shortstring` field as ASCII. The type hashes below are pinned, so an encodeType edit can't
 * silently shift the digest — the cross-layer golden vector (test_snip12.cairo /
 * snip12-call-set-signer.test.ts) reproduces this exact value on both sides.
 *
 * SNIP-12 revision-1 message hash:
 *   poseidon([
 *     shortstring("StarkNet Message"),
 *     domain_hash,        // poseidon(STARKNET_DOMAIN_TYPE_HASH, "CallSet", 1, chain_id, 1)
 *     account_address,    // SNIP-12 "account" slot = the signing user account
 *     call_set_hash,      // poseidon(CALL_SET_TYPE_HASH, poseidon([hash(call) …]), poseidon(additional_data))
 *   ])
 * where hash(call) = poseidon(CALL_TYPE_HASH, to, selector, poseidon(calldata)).
 */

import { ec, hash, num, shortString } from "starknet";
import type {
  BigNumberish,
  Call,
  DeclareSignerDetails,
  DeployAccountSignerDetails,
  InvocationsSignerDetails,
  Signature,
  SignerInterface,
  TypedData,
} from "starknet";

const poseidon = ec.starkCurve.poseidonHashMany;
const toFelt = (v: BigNumberish): bigint => num.toBigInt(v);

const STARKNET_MESSAGE = BigInt(shortString.encodeShortString("StarkNet Message"));

// Pinned SNIP-12 type hashes (sn_keccak of the encodeType strings). Identical to the Cairo verifier:
//   - STARKNET_DOMAIN: openzeppelin snip12 `StarknetDomain`.
//   - CALL: the canonical OZ SNIP-9 `Call` type (openzeppelin_account src9 snip12_utils).
//   - CALL_SET: privacy::snip12::CALL_SET_TYPE_HASH.
const STARKNET_DOMAIN_TYPE_HASH =
  0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210n;
const CALL_TYPE_HASH = 0x3635c7f2a7ba93844c0d064e18e487f35ab90f7c39d00f186a781fc3f0c2ca9n;
const CALL_SET_TYPE_HASH = 0x308b7462f924efba15fc992e6827eb3a748fcc79f091914156756437fa22909n;

// Domain for the generic `CallSet` authorization (privacy::snip12). Numeric version felt, not the
// shortstring '1', matching the on-chain verifier.
const CALL_SET_DOMAIN_NAME = BigInt(shortString.encodeShortString("CallSet"));
const CALL_SET_DOMAIN_VERSION = 1n;
const DOMAIN_REVISION = 1n;

/** SNIP-12 `Call` struct hash, matching OZ `CallStructHash`. */
function hashCall(call: Call): bigint {
  const calldata = (call.calldata ?? []) as BigNumberish[];
  return poseidon([
    CALL_TYPE_HASH,
    toFelt(call.contractAddress),
    toFelt(hash.getSelectorFromName(call.entrypoint)),
    poseidon(calldata.map(toFelt)),
  ]);
}

/** SNIP-12 `CallSet { calls, additional_data }` struct hash, matching `privacy::snip12::CallSet`. */
function hashCallSet(calls: Call[], additionalData: BigNumberish[]): bigint {
  return poseidon([
    CALL_SET_TYPE_HASH,
    poseidon(calls.map(hashCall)),
    poseidon(additionalData.map(toFelt)),
  ]);
}

/**
 * Recompute the SNIP-12 `CallSet` message hash the privacy pool verifies, for `calls` authorized by
 * `accountAddress` on the given `chainId` (the Starknet chain id felt). The off-chain golden oracle —
 * must equal `privacy::snip12::compute_call_set_hash(accountAddress, calls, additionalData)` under
 * the same chain id. `additionalData` is opaque extra data bound into the message; the privacy pool
 * passes it empty.
 */
export function computeCallSetHash(
  accountAddress: BigNumberish,
  calls: Call[],
  chainId: BigNumberish,
  additionalData: BigNumberish[] = []
): bigint {
  const domainHash = poseidon([
    STARKNET_DOMAIN_TYPE_HASH,
    CALL_SET_DOMAIN_NAME,
    CALL_SET_DOMAIN_VERSION,
    toFelt(chainId),
    DOMAIN_REVISION,
  ]);
  return poseidon([
    STARKNET_MESSAGE,
    domainHash,
    toFelt(accountAddress),
    hashCallSet(calls, additionalData),
  ]);
}

/** Signs a precomputed SNIP-12 message hash, yielding the depositor account's STARK signature. */
export type CallSetSignFn = (messageHash: bigint) => Signature | Promise<Signature>;

export interface Snip12CallSetSignerOptions {
  /** The signing user account address — the SNIP-12 "account" slot the message binds. */
  accountAddress: BigNumberish;
  /** Starknet chain id felt (e.g. `constants.StarknetChainId.SN_SEPOLIA`). */
  chainId: BigNumberish;
  /**
   * Produces the account's STARK signature over the SNIP-12 `CallSet` message hash. For a server key
   * this is `(h) => ec.starkCurve.sign(num.toHex(h), privateKey)`; for a wallet it wraps the wallet's
   * SNIP-12 typed-data signing. (The hash is provided pre-computed so all transports agree on it.)
   */
  sign: CallSetSignFn;
  /**
   * Opaque extra data bound into the signed `CallSet` message (e.g. a nonce). Defaults to empty,
   * matching the privacy pool, which passes no `additional_data`.
   */
  additionalData?: BigNumberish[];
}

/**
 * Plugs into `createPrivateTransfers({ account: { address, signer } })`. Only `signTransaction` is
 * exercised by the proving pipeline; the other `SignerInterface` methods are unsupported.
 */
export class Snip12CallSetSigner implements SignerInterface {
  constructor(private readonly options: Snip12CallSetSignerOptions) {}

  async signTransaction(calls: Call[], _details: InvocationsSignerDetails): Promise<Signature> {
    const messageHash = computeCallSetHash(
      this.options.accountAddress,
      calls,
      this.options.chainId,
      this.options.additionalData ?? []
    );
    return this.options.sign(messageHash);
  }

  async getPubKey(): Promise<string> {
    throw new Error("Snip12CallSetSigner: getPubKey is not supported");
  }

  async signMessage(_typedData: TypedData, _accountAddress: string): Promise<Signature> {
    throw new Error("Snip12CallSetSigner: signMessage is not supported");
  }

  async signDeclareTransaction(_details: DeclareSignerDetails): Promise<Signature> {
    throw new Error("Snip12CallSetSigner: signDeclareTransaction is not supported");
  }

  async signDeployAccountTransaction(_details: DeployAccountSignerDetails): Promise<Signature> {
    throw new Error("Snip12CallSetSigner: signDeployAccountTransaction is not supported");
  }
}
