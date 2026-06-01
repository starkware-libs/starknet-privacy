/**
 * Reference SNIP-12 signer for the privacy contract's depositor validation.
 *
 * Produces a signature that `privacy::snip12::verify_depositor_validation`
 * accepts. The typed-data layout here MUST stay in lockstep with the Cairo
 * verifier and with the sibling `py/validation_signer.py` — any drift on
 * one side breaks all three.
 *
 * Usage:
 *   npm run sign -- \
 *     --signer-private-key 0x... \
 *     --depositor 0x... \
 *     --issued-at 1700000000 \
 *     --chain-id SN_SEPOLIA
 *
 * Or import { signDepositorValidation } from another script/test.
 */

import { ec, num, typedData, type TypedData } from "starknet";

export interface SignDepositorValidationInput {
  signerPrivateKey: string;
  depositor: string;
  issuedAt: number | bigint | string;
  chainId: string;
}

export interface SignDepositorValidationOutput {
  messageHash: string;
  signature: { r: string; s: string };
  signerPublicKey: string;
  input: {
    depositor: string;
    issuedAt: string;
    chainId: string;
  };
}

const SNIP12_DOMAIN_NAME = "Screening";
const SNIP12_DOMAIN_VERSION = "2";
const PRIMARY_TYPE = "DepositorValidation";

function buildTypedData(depositor: string, issuedAt: string, chainId: string): TypedData {
  return {
    domain: {
      name: SNIP12_DOMAIN_NAME,
      version: SNIP12_DOMAIN_VERSION,
      chainId,
      revision: "1",
    },
    primaryType: PRIMARY_TYPE,
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      DepositorValidation: [
        { name: "depositor", type: "ContractAddress" },
        { name: "issued_at", type: "u128" },
      ],
    },
    message: { depositor, issued_at: issuedAt },
  };
}

export function signDepositorValidation(
  input: SignDepositorValidationInput
): SignDepositorValidationOutput {
  const signerPublicKey = ec.starkCurve.getStarkKey(input.signerPrivateKey);
  const issuedAt = BigInt(input.issuedAt).toString();
  const td = buildTypedData(input.depositor, issuedAt, input.chainId);
  const messageHash = typedData.getMessageHash(td, signerPublicKey);
  const signature = ec.starkCurve.sign(messageHash, input.signerPrivateKey);
  return {
    messageHash: num.toHex(messageHash),
    signature: {
      r: num.toHex(signature.r),
      s: num.toHex(signature.s),
    },
    signerPublicKey: num.toHex(signerPublicKey),
    input: {
      depositor: num.toHex(input.depositor),
      issuedAt,
      chainId: input.chainId,
    },
  };
}

function parseArgs(argv: string[]): SignDepositorValidationInput {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near "${key}"`);
    }
    flags.set(key.slice(2), value);
  }
  const required = ["signer-private-key", "depositor", "issued-at", "chain-id"];
  for (const name of required) {
    if (!flags.has(name)) {
      throw new Error(`Missing required --${name}`);
    }
  }
  return {
    signerPrivateKey: flags.get("signer-private-key")!,
    depositor: flags.get("depositor")!,
    issuedAt: flags.get("issued-at")!,
    chainId: flags.get("chain-id")!,
  };
}

const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  try {
    const input = parseArgs(process.argv.slice(2));
    const result = signDepositorValidation(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}
