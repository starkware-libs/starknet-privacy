import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { Account, CallData, RpcProvider, num, type Abi } from "starknet";
import { declareClass, deployContract, repoRoot } from "./utils.js";

/**
 * Deploys a `StarknetEth712Account` (from `starkware_accounts`, emitted by the privacy test build) on
 * devnet: a Starknet account that validates EVM/secp256k1 EIP-712 signatures. The account has no
 * constructor — deploy it via the UDC, then `initialize(eth_address, ownership_signature)` proves
 * EVM-key ownership and registers its SRC5 interfaces (incl. custom-signature-validation).
 */

const TEST_BUILD_DIR = join(repoRoot(), "target/dev");
const ACCOUNT_CONTRACT =
  "privacy_unittest_StarknetEth712Account.test.contract_class.json";

// keccak256("\x19Ethereum Signed Message:\n41Sign to verify that you own this account.")
// (starkware_accounts::eth_712_utils::OWNERSHIP_TRANSFER_MSG_HASH) — signing it with the EVM key
// proves account ownership at initialize().
const OWNERSHIP_TRANSFER_MSG_HASH =
  0x3ce976d55131cd0bdd49f20afbded052d8e907dc6034d95cdf117a8fd7752e3cn;

function to32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let rest = value;
  for (let index = 31; index >= 0; index--) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** The EVM address (low 160 bits of keccak(uncompressed pubkey)) for a secp256k1 private key. */
export function evmAddress(evmPrivateKey: bigint): bigint {
  const publicKey = secp256k1.getPublicKey(to32(evmPrivateKey), false).slice(1); // drop 0x04 prefix
  return bytesToBigInt(keccak_256(publicKey).slice(12));
}

/**
 * The EVM ownership signature over the fixed `OWNERSHIP_TRANSFER_MSG_HASH`, as the account's
 * `Signature { r, s, y_parity }`. `y_parity` matches the 6-felt convention the account uses
 * elsewhere (`v = 27 + recovery`, `y_parity = v % 2 == 0`), i.e. an odd recovery id.
 */
function ownershipSignature(evmPrivateKey: bigint): {
  r: bigint;
  s: bigint;
  y_parity: boolean;
} {
  const signature = secp256k1.sign(
    to32(OWNERSHIP_TRANSFER_MSG_HASH),
    to32(evmPrivateKey),
  );
  return {
    r: signature.r,
    s: signature.s,
    y_parity: signature.recovery % 2 === 1,
  };
}

async function declareEth712Account(
  admin: Account,
  provider: RpcProvider,
): Promise<string> {
  const sierraPath = join(TEST_BUILD_DIR, ACCOUNT_CONTRACT);
  const casmPath = join(
    mkdtempSync(join(tmpdir(), "eth712-casm-")),
    "account.casm.json",
  );
  execFileSync("universal-sierra-compiler", [
    "compile-contract",
    "--sierra-path",
    sierraPath,
    "--output-path",
    casmPath,
  ]);
  return declareClass(admin, provider, sierraPath, casmPath);
}

export interface Eth712Account {
  /** The deployed Starknet account address. */
  address: string;
  /** The EVM address the account validates signatures against. */
  ethAddress: bigint;
  /** The account ABI, for compiling `is_custom_signature_valid` / `execute_from_outside_v2` calls. */
  abi: Abi;
}

/** Declare, UDC-deploy, and initialize a `StarknetEth712Account` owned by `evmPrivateKey`. */
export async function deployEth712Account(
  admin: Account,
  provider: RpcProvider,
  evmPrivateKey: bigint,
): Promise<Eth712Account> {
  const classHash = await declareEth712Account(admin, provider);
  const abi: Abi = JSON.parse(
    readFileSync(join(TEST_BUILD_DIR, ACCOUNT_CONTRACT), "utf8"),
  ).abi;
  const address = await deployContract(
    admin,
    provider,
    classHash,
    [],
    "0xe712",
  );

  const ethAddress = evmAddress(evmPrivateKey);
  const initialize = await admin.execute({
    contractAddress: address,
    entrypoint: "initialize",
    calldata: new CallData(abi).compile("initialize", {
      eth_address: num.toHex(ethAddress),
      signature: ownershipSignature(evmPrivateKey),
    }),
  });
  await provider.waitForTransaction(initialize.transaction_hash);

  return { address, ethAddress, abi };
}
