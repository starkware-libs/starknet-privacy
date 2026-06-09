/**
 * Test-only SNIP-12 signer for the privacy contract's depositor screening.
 *
 * Produces a signature that `privacy::snip12::verify_depositor_validation`
 * accepts. The typed-data layout MUST stay in lockstep with the Cairo verifier
 * (`packages/privacy/src/snip12.cairo`) and the reference signers under
 * `scripts/address_validation_signer/` — drift on any side breaks all of them.
 *
 * In production the screening service signs this; the devnet test harness signs
 * it locally so deposits can be screened end-to-end without a real service.
 */

import { ec, shortString, typedData, type TypedData } from "starknet";
import type { ScreeningSignature } from "../interfaces.js";

const SNIP12_DOMAIN_NAME = "Screening";
const SNIP12_DOMAIN_VERSION = "2";
const PRIMARY_TYPE = "DepositorValidation";

function buildTypedData(depositor: string, issuedAt: string, chainId: string): TypedData {
  return {
    domain: { name: SNIP12_DOMAIN_NAME, version: SNIP12_DOMAIN_VERSION, chainId, revision: "1" },
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

/** Public key (felt252, 0x-hex) of the screener identified by `privateKey`. */
export function screenerPublicKey(privateKey: string): string {
  return ec.starkCurve.getStarkKey(privateKey);
}

/**
 * Sign a `DepositorValidation { depositor, issued_at }` under `privateKey`.
 *
 * `chainId` must be the short string (e.g. "SN_SEPOLIA"), matching the felt the
 * contract reads from `get_tx_info().chain_id`. Returns the on-the-wire
 * `ScreeningSignature` (issued_at + r/s) for the proof's `additionalData`.
 */
export function signDepositorValidation(
  privateKey: string,
  depositor: string,
  issuedAt: number,
  chainId: string
): ScreeningSignature {
  const publicKey = screenerPublicKey(privateKey);
  const message = buildTypedData(depositor, BigInt(issuedAt).toString(), chainId);
  const messageHash = typedData.getMessageHash(message, publicKey);
  const signature = ec.starkCurve.sign(messageHash, privateKey);
  return {
    issued_at: issuedAt,
    sig_r: "0x" + signature.r.toString(16),
    sig_s: "0x" + signature.s.toString(16),
  };
}

/** Decode a chain-id felt (e.g. the StarknetChainId hex) back to its short string. */
export function chainIdShortString(chainId: string): string {
  return shortString.decodeShortString(chainId);
}
