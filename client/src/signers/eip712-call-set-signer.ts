/**
 * EIP-712 `CallSet` signers (EVM wallets, for an `Eth712Account`).
 *
 * Two `SignerInterface` implementations, one per signature source, selected explicitly (by the factory
 * or the dapp) rather than by a runtime `sign` / `signTypedData` toggle:
 *   - {@link Eip712TypedDataSigner} — a browser wallet (MetaMask …) via `eth_signTypedData_v4`; the
 *     wallet is handed the EIP-712 typed data and returns a 65-byte `(r‖s‖v)` signature.
 *   - {@link Eip712HashSigner} — a raw secp256k1 key (server-side / tests) signing the message hash.
 *
 * Both authorize the account's invocation (any operation — deposit / transfer / withdraw / setup …) by
 * signing the EIP-712 `CallSet` message the Eth712Account verifies in `is_custom_signature_valid`
 * (earn-contracts eth_712_utils.cairo `get_call_set_hash`) — which the privacy pool calls for a capable
 * account. Both return the account's 6-felt signature `[r_high, r_low, s_high, s_low, v, evm_chain_id]`.
 *
 * Keccak-based and byte-compatible with browser wallets' `eth_signTypedData_v4`. The hashing and typed
 * data live in shared free functions ({@link computeCallSet712Hash}, {@link callSetTypedData}); the type
 * hashes + domain layout mirror earn-contracts exactly.
 *
 *   msg = keccak256( 0x19 0x01 || domainSeparator || hashStruct(CallSet) )
 *   domainSeparator = keccak256(EIP712_DOMAIN_TYPE_HASH, keccak256(snChainName), keccak256("2"),
 *                               evmChainId, account & 2^128-1)
 *   hashStruct(CallSet) = keccak256(CALL_SET_TYPE_HASH, hashCallArray(calls), hashFeltArray(additional_data))
 *   hashCall(call) = keccak256(CALL_TYPE_HASH, to, selector, keccak256(calldata felts))
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { concatBytes, hexToBytes } from "@noble/hashes/utils";
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

// The EIP-712 domain version is the constant "2"; `eip712DomainSeparator` keccaks it.
const DOMAIN_VERSION = "2";

/**
 * EIP-712 type definitions for `eth_signTypedData_v4`. A wallet derives the type hashes from these
 * the same way, so `keccak(encodeType)` of each equals the pinned constants above — meaning the
 * wallet's v4 digest equals {@link computeCallSet712Hash}.
 */
export const CALL_SET_EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  CallSet: [
    { name: "calls", type: "Call[]" },
    { name: "additional_data", type: "uint256[]" },
  ],
  Call: [
    { name: "address", type: "uint256" },
    { name: "selector", type: "uint256" },
    { name: "data", type: "uint256[]" },
  ],
} as const;

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

// EIP-712 type hashes = keccak of the encodeType string (computed once at load, not hand-pinned). These
// mirror the same-named constants in starkware_accounts::eth_712_utils; the type-hash test pins each
// against the on-chain golden value.
const keccakType = (encodeType: string): bigint => keccak(new TextEncoder().encode(encodeType));
const EIP712_DOMAIN_TYPE_HASH = keccakType(
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
);
const CALL_TYPE_HASH = keccakType("Call(uint256 address,uint256 selector,uint256[] data)");
const CALL_SET_TYPE_HASH = keccakType(
  "CallSet(Call[] calls,uint256[] additional_data)Call(uint256 address,uint256 selector,uint256[] data)"
);
const OUTSIDE_EXECUTION_TYPE_HASH = keccakType(
  "OutsideExecution(Call[] calls,uint256 caller,uint256 nonce,uint256 execute_after,uint256 execute_before)Call(uint256 address,uint256 selector,uint256[] data)"
);

// EIP-712 message hash: keccak256(0x19 0x01 || domainSeparator || structHash).
const wrapEip712 = (domainSep: bigint, structHash: bigint): bigint =>
  keccak(concatBytes(Uint8Array.from([0x19, 0x01]), to32(domainSep), to32(structHash)));

// keccak of the per-item struct hashes concatenated (empty → keccak("")), matching Cairo push_*_array.
const hashArray = <T>(items: T[], hashItem: (item: T) => bigint): bigint =>
  keccak(concatBytes(...items.map((item) => to32(hashItem(item)))));

// The EIP-712 `Call` struct hash: keccak256(CALL_TYPE_HASH, address, selector, keccak256(data felts)).
const hashCallStruct = (address: bigint, selector: bigint, data: bigint[]): bigint =>
  keccakFelts(CALL_TYPE_HASH, address, selector, keccak(concatBytes(...data.map(to32))));

const hashCall = (call: Call): bigint =>
  hashCallStruct(
    toFelt(call.contractAddress),
    toFelt(hash.getSelectorFromName(call.entrypoint)),
    ((call.calldata ?? []) as BigNumberish[]).map(toFelt)
  );

const hashCallArray = (calls: Call[]): bigint => hashArray(calls, hashCall);

// keccak of the concatenated u256-encoded felts (empty → keccak("")), matching Cairo push_felt_array.
const hashFeltArray = (felts: bigint[]): bigint => keccak(concatBytes(...felts.map(to32)));

const hashCallSet = (calls: Call[], additionalData: bigint[]): bigint =>
  keccakFelts(CALL_SET_TYPE_HASH, hashCallArray(calls), hashFeltArray(additionalData));

/**
 * EIP-712 domain separator: `keccak(EIP712_DOMAIN_TYPE_HASH, keccak(name), keccak(version), chainId,
 * verifyingContract)`. `verifyingContract` is used as given (the account's low 128 bits) so the digest
 * matches what a wallet computes from the same domain object.
 */
function eip712DomainSeparator(
  name: string,
  version: string,
  chainId: bigint,
  verifyingContract: bigint
): bigint {
  return keccakFelts(
    EIP712_DOMAIN_TYPE_HASH,
    keccak(new TextEncoder().encode(name)),
    keccak(new TextEncoder().encode(version)),
    chainId,
    verifyingContract
  );
}

/**
 * Recompute the EIP-712 `CallSet` message hash the Eth712Account verifies, for `calls` authorized by
 * `accountAddress` on `snChainName` (the Starknet chain name, e.g. "SN_SEPOLIA") with EIP-712 domain
 * `chainId = evmChainId`. `additionalData` is opaque extra data bound into the message (the privacy
 * pool passes it empty). The off-chain oracle — must equal
 * `starkware_accounts::eth_712_utils::get_call_set_hash`.
 */
export function computeCallSet712Hash(
  accountAddress: BigNumberish,
  calls: Call[],
  snChainName: string,
  evmChainId: BigNumberish,
  additionalData: BigNumberish[] = []
): bigint {
  const ds = eip712DomainSeparator(
    snChainName,
    DOMAIN_VERSION,
    toFelt(evmChainId),
    toFelt(accountAddress) & MASK_128
  );
  const sh = hashCallSet(calls, additionalData.map(toFelt));
  return wrapEip712(ds, sh);
}

/** A SNIP-9 call as it appears in an OutsideExecution message: the selector is already hashed. */
export interface OutsideExecutionCall {
  address: BigNumberish;
  selector: BigNumberish;
  data: BigNumberish[];
}

const hashOutsideCall = (call: OutsideExecutionCall): bigint =>
  hashCallStruct(toFelt(call.address), toFelt(call.selector), call.data.map(toFelt));

/** The EIP-712 domain of an `OutsideExecution`, as carried in the typed data (fields used as given). */
export interface OutsideExecution712Domain {
  name: string;
  version: string;
  chainId: BigNumberish;
  verifyingContract: BigNumberish;
}

/**
 * Inputs to {@link computeOutsideExecution712Hash}. A struct rather than positional args because most
 * fields are same-typed felts, so an ordering mistake would silently produce a valid-but-wrong hash.
 */
export interface OutsideExecution712Input {
  domain: OutsideExecution712Domain;
  calls: OutsideExecutionCall[];
  caller: BigNumberish;
  nonce: BigNumberish;
  executeAfter: BigNumberish;
  executeBefore: BigNumberish;
}

/**
 * Recompute the EIP-712 `OutsideExecution` message hash the Eth712Account verifies in
 * `execute_from_outside_v2` — `starkware_accounts::eth_712_utils::get_outside_execution_hash`. The
 * domain is taken from the supplied `domain` (the caller/paymaster's typed data), not re-derived here:
 * the account re-derives and verifies it on-chain, so a wrong domain only yields a rejected signature.
 * `calls` carry raw (already-hashed) selectors, matching the SNIP-9 OutsideExecution the paymaster relays.
 */
export function computeOutsideExecution712Hash(input: OutsideExecution712Input): bigint {
  const { domain, calls, caller, nonce, executeAfter, executeBefore } = input;
  const callArray = hashArray(calls, hashOutsideCall);
  const structHash = keccakFelts(
    OUTSIDE_EXECUTION_TYPE_HASH,
    callArray,
    toFelt(caller),
    toFelt(nonce),
    toFelt(executeAfter),
    toFelt(executeBefore)
  );
  const ds = eip712DomainSeparator(
    domain.name,
    domain.version,
    toFelt(domain.chainId),
    toFelt(domain.verifyingContract)
  );
  return wrapEip712(ds, structHash);
}

/** The EIP-712 typed data of a `CallSet`; its `eth_signTypedData_v4` digest equals {@link computeCallSet712Hash}. */
export type CallSetTypedData = ReturnType<typeof callSetTypedData>;

/**
 * Builds the EIP-712 typed-data object for `eth_signTypedData_v4`. `verifyingContract` is the
 * account's low 128 bits (per earn-contracts); `chainId` is the source EVM chain id.
 */
export function callSetTypedData(
  accountAddress: BigNumberish,
  calls: Call[],
  snChainName: string,
  evmChainId: BigNumberish,
  additionalData: BigNumberish[] = []
) {
  return {
    types: CALL_SET_EIP712_TYPES,
    primaryType: "CallSet" as const,
    domain: {
      name: snChainName,
      version: "2",
      chainId: num.toHex(toFelt(evmChainId)),
      verifyingContract: num.toHex(toFelt(accountAddress) & MASK_128),
    },
    message: {
      calls: calls.map((call) => ({
        address: num.toHex(toFelt(call.contractAddress)),
        selector: num.toHex(toFelt(hash.getSelectorFromName(call.entrypoint))),
        data: ((call.calldata ?? []) as BigNumberish[]).map((felt) => num.toHex(toFelt(felt))),
      })),
      additional_data: additionalData.map((felt) => num.toHex(toFelt(felt))),
    },
  };
}

/**
 * EIP-712 type definitions for an `OutsideExecution` typed data (`eth_signTypedData_v4`). The paymaster
 * builds this so both the wallet and {@link computeOutsideExecution712Hash} hash the same OutsideExecution.
 */
export const OUTSIDE_EXECUTION_EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  OutsideExecution: [
    { name: "calls", type: "Call[]" },
    { name: "caller", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "execute_after", type: "uint256" },
    { name: "execute_before", type: "uint256" },
  ],
  Call: [
    { name: "address", type: "uint256" },
    { name: "selector", type: "uint256" },
    { name: "data", type: "uint256[]" },
  ],
} as const;

/**
 * Builds the EIP-712 `OutsideExecution` typed data the paymaster hands the signer. The domain mirrors
 * the account's on-chain domain (name = Starknet chain, version "2", `verifyingContract` = account low
 * 128 bits, `chainId` = source EVM chain); the account re-derives and verifies it on-chain, so a wrong
 * domain only yields a rejected signature. `calls` carry raw (already-hashed) selectors.
 */
export function outsideExecutionTypedData(input: {
  accountAddress: BigNumberish;
  snChainName: string;
  evmChainId: BigNumberish;
  calls: OutsideExecutionCall[];
  caller: BigNumberish;
  nonce: BigNumberish;
  executeAfter: BigNumberish;
  executeBefore: BigNumberish;
}) {
  return {
    types: OUTSIDE_EXECUTION_EIP712_TYPES,
    primaryType: "OutsideExecution" as const,
    domain: {
      name: input.snChainName,
      version: DOMAIN_VERSION,
      chainId: num.toHex(toFelt(input.evmChainId)),
      verifyingContract: num.toHex(toFelt(input.accountAddress) & MASK_128),
    },
    message: {
      calls: input.calls.map((call) => ({
        address: num.toHex(toFelt(call.address)),
        selector: num.toHex(toFelt(call.selector)),
        data: call.data.map((felt) => num.toHex(toFelt(felt))),
      })),
      caller: num.toHex(toFelt(input.caller)),
      nonce: num.toHex(toFelt(input.nonce)),
      execute_after: num.toHex(toFelt(input.executeAfter)),
      execute_before: num.toHex(toFelt(input.executeBefore)),
    },
  };
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

/** Signs the EIP-712 message hash and yields its secp256k1 components (e.g. a raw server key). */
export type Eip712SignFn = (messageHash: bigint) => EthSignatureParts | Promise<EthSignatureParts>;

/** Convenience transport for a raw EVM private key (server-side / tests). */
export function secp256k1SignFn(privateKey: BigNumberish): Eip712SignFn {
  const pk = to32(toFelt(privateKey));
  return (messageHash: bigint) => {
    const sig = secp256k1.sign(to32(messageHash), pk);
    return { r: sig.r, s: sig.s, v: 27 + sig.recovery };
  };
}

/**
 * Signs the EIP-712 typed data via a browser wallet's `eth_signTypedData_v4`, returning the
 * 0x-prefixed 65-byte `(r ‖ s ‖ v)` hex signature. E.g. with ethers:
 * `(td) => signer.signTypedData(td.domain, { CallSet: td.types.CallSet, Call: td.types.Call }, td.message)`.
 */
export type Eip712SignTypedDataFn = (typedData: CallSetTypedData) => string | Promise<string>;

/**
 * Splits a 0x-prefixed 65-byte `(r ‖ s ‖ v)` signature into its components, normalizing the yParity
 * `v` (0/1) to the legacy 27/28 the account expects. Assumes `eth_signTypedData_v4` semantics: rejects
 * any other `v` (e.g. an EIP-155 chain-encoded `v = 2*chainId + 35/36`) rather than mis-normalizing it.
 */
function parseEthSignature(hexSignature: string): EthSignatureParts {
  const bytes = hexToBytes(hexSignature.startsWith("0x") ? hexSignature.slice(2) : hexSignature);
  const v = bytes[64];
  if (v !== 0 && v !== 1 && v !== 27 && v !== 28) {
    throw new Error(`unexpected signature recovery byte v=${v}; expected 0/1 or 27/28`);
  }
  return {
    r: bytesToBigInt(bytes.slice(0, 32)),
    s: bytesToBigInt(bytes.slice(32, 64)),
    v: v < 27 ? v + 27 : v,
  };
}

/** Common configuration shared by both EIP-712 `CallSet` signers. */
export interface Eip712SignerOptions {
  /** The Eth712Account address — its low 128 bits are the EIP-712 `verifyingContract`. */
  accountAddress: BigNumberish;
  /** Starknet chain name string, e.g. "SN_SEPOLIA" — keccak'd into the EIP-712 domain `name`. */
  snChainName: string;
  /** EIP-712 domain `chainId` (the source EVM chain id); also rides as felt[5] of the signature. */
  evmChainId: BigNumberish;
  /** Opaque extra data bound into the signed `CallSet` message. Defaults to empty, matching the pool. */
  additionalData?: BigNumberish[];
}

/**
 * Shared base for the EIP-712 `CallSet` signers. Plugs into
 * `createPrivateTransfers({ account: { address, signer } })` for an Eth712Account depositor: only
 * `signTransaction` is exercised (it derives the 6-felt account signature from the subclass's
 * secp256k1 components); the other `SignerInterface` methods are unsupported.
 */
abstract class Eip712CallSetSignerBase<
  TOptions extends Eip712SignerOptions,
> implements SignerInterface {
  protected constructor(protected readonly options: TOptions) {}

  /** Produce the secp256k1 components over this `CallSet` — the signature-source-specific step. */
  protected abstract signParts(calls: Call[]): Promise<EthSignatureParts>;

  async signTransaction(calls: Call[], _details: InvocationsSignerDetails): Promise<Signature> {
    const parts = await this.signParts(calls);
    return toSixFelt(parts, toFelt(this.options.evmChainId));
  }

  async getPubKey(): Promise<string> {
    throw new Error(`${this.constructor.name}: getPubKey is not supported`);
  }

  /** Produce the secp256k1 components over an `OutsideExecution` message — source-specific. */
  protected abstract signOutsideExecution(typedData: TypedData): Promise<EthSignatureParts>;

  /**
   * Signs the SNIP-9 `OutsideExecution` EIP-712 message the Eth712Account verifies in
   * `execute_from_outside_v2` — the envelope the privacy paymaster relays for a deposit's `approve`.
   * Returns the account's 6-felt signature.
   */
  async signMessage(typedData: TypedData, _accountAddress: string): Promise<Signature> {
    // This path only signs OutsideExecution — `outsideExecutionHash` reads OutsideExecution message
    // fields, so reject anything else instead of hashing over misread/missing fields.
    if (typedData.primaryType !== "OutsideExecution") {
      throw new Error(
        `${this.constructor.name}: signMessage only signs OutsideExecution typed data, ` +
          `got primaryType "${typedData.primaryType}"`
      );
    }
    const parts = await this.signOutsideExecution(typedData);
    // felt[5] is the EVM chain id the account reads back from the signature and folds into the domain,
    // so it must be the chain id in the signed domain — taken from the typed data, not the signer config.
    const domain = typedData.domain as unknown as OutsideExecution712Domain;
    return toSixFelt(parts, toFelt(domain.chainId));
  }

  /** The EIP-712 `OutsideExecution` message hash from the typed data's domain + message fields. */
  protected outsideExecutionHash(typedData: TypedData): bigint {
    const domain = typedData.domain as unknown as OutsideExecution712Domain;
    const message = typedData.message as {
      calls: OutsideExecutionCall[];
      caller: BigNumberish;
      nonce: BigNumberish;
      execute_after: BigNumberish;
      execute_before: BigNumberish;
    };
    return computeOutsideExecution712Hash({
      domain,
      calls: message.calls,
      caller: message.caller,
      nonce: message.nonce,
      executeAfter: message.execute_after,
      executeBefore: message.execute_before,
    });
  }

  async signDeclareTransaction(_details: DeclareSignerDetails): Promise<Signature> {
    throw new Error(`${this.constructor.name}: signDeclareTransaction is not supported`);
  }

  async signDeployAccountTransaction(_details: DeployAccountSignerDetails): Promise<Signature> {
    throw new Error(`${this.constructor.name}: signDeployAccountTransaction is not supported`);
  }
}

export interface Eip712HashSignerOptions extends Eip712SignerOptions {
  /** Raw signer over the EIP-712 message hash (e.g. `secp256k1SignFn` for a server key). */
  sign: Eip712SignFn;
}

/**
 * Signs the EIP-712 `CallSet` message hash with a raw secp256k1 key (server-side / tests). Computes the
 * digest itself and calls {@link Eip712HashSignerOptions.sign} — unsuitable for browser wallets, which
 * will not sign an arbitrary 32-byte hash (use {@link Eip712TypedDataSigner} there).
 */
export class Eip712HashSigner extends Eip712CallSetSignerBase<Eip712HashSignerOptions> {
  constructor(options: Eip712HashSignerOptions) {
    super(options);
  }

  protected async signParts(calls: Call[]): Promise<EthSignatureParts> {
    const { accountAddress, snChainName, evmChainId, additionalData } = this.options;
    return this.options.sign(
      computeCallSet712Hash(accountAddress, calls, snChainName, evmChainId, additionalData ?? [])
    );
  }

  protected async signOutsideExecution(typedData: TypedData): Promise<EthSignatureParts> {
    return this.options.sign(this.outsideExecutionHash(typedData));
  }
}

export interface Eip712TypedDataSignerOptions extends Eip712SignerOptions {
  /** Browser-wallet signer via `eth_signTypedData_v4` (receives the typed data, returns 65-byte hex). */
  signTypedData: Eip712SignTypedDataFn;
}

/**
 * Signs the EIP-712 `CallSet` via a browser wallet's `eth_signTypedData_v4`: hands the wallet the typed
 * data (so it derives and displays the digest itself) and parses the returned 65-byte `(r‖s‖v)`
 * signature. The wallet's v4 digest equals {@link computeCallSet712Hash} for these types.
 */
export class Eip712TypedDataSigner extends Eip712CallSetSignerBase<Eip712TypedDataSignerOptions> {
  constructor(options: Eip712TypedDataSignerOptions) {
    super(options);
  }

  protected async signParts(calls: Call[]): Promise<EthSignatureParts> {
    const { accountAddress, snChainName, evmChainId, additionalData } = this.options;
    const signature = await this.options.signTypedData(
      callSetTypedData(accountAddress, calls, snChainName, evmChainId, additionalData ?? [])
    );
    return parseEthSignature(signature);
  }

  protected async signOutsideExecution(typedData: TypedData): Promise<EthSignatureParts> {
    return parseEthSignature(
      await this.options.signTypedData(typedData as unknown as CallSetTypedData)
    );
  }
}
