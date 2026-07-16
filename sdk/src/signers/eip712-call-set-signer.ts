/**
 * EIP-712 `CallSet` signer (Browser EVM wallets, or an EVM server key, for an
 * `Eth712Account`).
 *
 * A `SignerInterface` whose `signTransaction` authorizes the account's invocation (any operation —
 * deposit / transfer / withdraw / setup …) by signing the EIP-712 `CallSet` message the Eth712Account
 * verifies in `is_custom_signature_valid` (earn-contracts eth_712_utils.cairo `get_call_set_hash`) —
 * which the privacy pool calls for a capable account. See the README "Account signers
 * (native-wallet support)" section. Returns the account's 6-felt signature
 * `[r_high, r_low, s_high, s_low, v, evm_chain_id]`.
 *
 * Keccak-based (so it is byte-compatible with the keccak Cairo verifier and with browser wallets'
 * `eth_signTypedData_v4`), via `@noble/hashes`. The type hashes + domain layout below mirror L1
 * exactly; the cross-layer golden vector is reproduced by `scripts/eip712.py::call_set_msg_hash`
 * (earn-contracts) and pinned in the test.
 *
 *   msg = keccak256( 0x19 0x01 || domainSeparator || hashStruct(CallSet) )
 *   domainSeparator = keccak256(EIP712_DOMAIN_TYPE_HASH, keccak256(snChainName), keccak256("2"),
 *                               evmChainId, account & 2^128-1)
 *   hashStruct(CallSet) = keccak256(CALL_SET_TYPE_HASH, hashCallArray(calls), hashFeltArray(additional_data))
 *   hashCall(call) = keccak256(CALL_TYPE_HASH, to, selector, keccak256(calldata felts))
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes } from "@noble/hashes/utils";
import { hash, num } from "starknet";
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

const MASK_128 = (1n << 128n) - 1n;
const toFelt = (v: BigNumberish): bigint => num.toBigInt(v);

// EIP-712 type hashes (keccak of the encodeType strings) — identical to earn-contracts
// eth_712_utils.cairo.
const EIP712_DOMAIN_TYPE_HASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400fn;
const CALL_TYPE_HASH = 0x7793b9bed3b87c6119fe923f0da4e85e1f97a03272a446514622ee7bd62ad25fn;
const CALL_SET_TYPE_HASH = 0xa6b8079d8aedb3bfd5ee9effaf1c1d19c1514c55ed0dc439faf8aabe5460582fn;
const VERSION_HASH = 0xad7c5bef027816a800da1736444fb58a807ef4c9603b7848673f7e3a68eb14a5n; // keccak("2")

function bytesToBigInt(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x;
}

/** 32-byte big-endian encoding of a felt/u256 (matches Cairo `push_u256`). */
function to32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

const keccak = (b: Uint8Array): bigint => bytesToBigInt(keccak_256(b));
const keccakFelts = (...vals: bigint[]): bigint => keccak(concatBytes(...vals.map(to32)));

function hashCall(call: Call): bigint {
  const calldata = ((call.calldata ?? []) as BigNumberish[]).map(toFelt);
  return keccakFelts(
    CALL_TYPE_HASH,
    toFelt(call.contractAddress),
    toFelt(hash.getSelectorFromName(call.entrypoint)),
    keccak(concatBytes(...calldata.map(to32)))
  );
}

const hashCallArray = (calls: Call[]): bigint =>
  keccak(concatBytes(...calls.map((c) => to32(hashCall(c)))));

/** EIP-712 `uint256[]` array hash (matches Cairo `push_felt_array` / py `hash_felt_array`). */
const hashFeltArray = (felts: bigint[]): bigint => keccak(concatBytes(...felts.map(to32)));

const hashCallSet = (calls: Call[], additionalData: bigint[]): bigint =>
  keccakFelts(CALL_SET_TYPE_HASH, hashCallArray(calls), hashFeltArray(additionalData));

function domainSeparator(snChainName: string, account: bigint, evmChainId: bigint): bigint {
  const nameHash = keccak(new TextEncoder().encode(snChainName));
  return keccakFelts(
    EIP712_DOMAIN_TYPE_HASH,
    nameHash,
    VERSION_HASH,
    evmChainId,
    account & MASK_128
  );
}

/**
 * Recompute the EIP-712 `CallSet` message hash the Eth712Account verifies, for `calls` authorized by
 * `accountAddress` on `snChainName` (the Starknet chain name, e.g. "SN_SEPOLIA") with EIP-712 domain
 * `chainId = evmChainId`. The off-chain golden oracle — must equal
 * earn-contracts `get_call_set_hash` / `scripts/eip712.py::call_set_msg_hash`.
 */
export function computeCallSet712Hash(
  accountAddress: BigNumberish,
  calls: Call[],
  snChainName: string,
  evmChainId: BigNumberish,
  additionalData: BigNumberish[] = []
): bigint {
  const ds = domainSeparator(snChainName, toFelt(accountAddress), toFelt(evmChainId));
  const sh = hashCallSet(calls, additionalData.map(toFelt));
  return keccak(concatBytes(Uint8Array.from([0x19, 0x01]), to32(ds), to32(sh)));
}

/** secp256k1 signature components of the EIP-712 message hash. `v` is 27/28 (yParity + 27). */
export interface EthSignatureParts {
  r: bigint;
  s: bigint;
  v: number;
}

/** Splits a signature into the account's 6-felt form `[r_high,r_low,s_high,s_low,v,evm_chain_id]`. */
function toSixFelt(sig: EthSignatureParts, evmChainId: bigint): string[] {
  return [
    sig.r >> 128n,
    sig.r & MASK_128,
    sig.s >> 128n,
    sig.s & MASK_128,
    BigInt(sig.v),
    evmChainId,
  ].map(num.toHex);
}

/** Signs the EIP-712 message hash and yields its secp256k1 components. */
export type Eip712SignFn = (messageHash: bigint) => EthSignatureParts | Promise<EthSignatureParts>;

/** Convenience transport for a raw EVM private key (server-side / tests). */
export function secp256k1SignFn(privateKey: BigNumberish): Eip712SignFn {
  const pk = to32(toFelt(privateKey));
  return (messageHash: bigint) => {
    const sig = secp256k1.sign(to32(messageHash), pk);
    return { r: sig.r, s: sig.s, v: 27 + sig.recovery };
  };
}

export interface Eip712CallSetSignerOptions {
  /** The Eth712Account address — its low 128 bits are the EIP-712 `verifyingContract`. */
  accountAddress: BigNumberish;
  /** Starknet chain name string, e.g. "SN_SEPOLIA" — keccak'd into the EIP-712 domain `name`. */
  snChainName: string;
  /** EIP-712 domain `chainId` (the source EVM chain id); also rides as felt[5] of the signature. */
  evmChainId: BigNumberish;
  /** Produces the secp256k1 signature over the EIP-712 message hash (wallet or `secp256k1SignFn`). */
  sign: Eip712SignFn;
  /**
   * Opaque extra data bound into the signed `CallSet` message (e.g. a nonce). Defaults to empty,
   * matching the privacy pool, which passes no `additional_data`.
   */
  additionalData?: BigNumberish[];
}

/**
 * Plugs into `createPrivateTransfers({ account: { address, signer } })` for an Eth712Account
 * depositor. Only `signTransaction` is exercised; the other `SignerInterface` methods are unsupported.
 */
export class Eip712CallSetSigner implements SignerInterface {
  constructor(private readonly options: Eip712CallSetSignerOptions) {}

  async signTransaction(calls: Call[], _details: InvocationsSignerDetails): Promise<Signature> {
    const messageHash = computeCallSet712Hash(
      this.options.accountAddress,
      calls,
      this.options.snChainName,
      this.options.evmChainId,
      this.options.additionalData ?? []
    );
    const sig = await this.options.sign(messageHash);
    return toSixFelt(sig, toFelt(this.options.evmChainId));
  }

  async getPubKey(): Promise<string> {
    throw new Error("Eip712CallSetSigner: getPubKey is not supported");
  }

  async signMessage(_typedData: TypedData, _accountAddress: string): Promise<Signature> {
    throw new Error("Eip712CallSetSigner: signMessage is not supported");
  }

  async signDeclareTransaction(_details: DeclareSignerDetails): Promise<Signature> {
    throw new Error("Eip712CallSetSigner: signDeclareTransaction is not supported");
  }

  async signDeployAccountTransaction(_details: DeployAccountSignerDetails): Promise<Signature> {
    throw new Error("Eip712CallSetSigner: signDeployAccountTransaction is not supported");
  }
}
