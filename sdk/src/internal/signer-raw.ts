/**
 * Signer that exposes signRaw for signing a precomputed message hash.
 * Uses starknet's Signer implementation; only the visibility of signRaw is public.
 */

import type { SignerRawInterface } from "../interfaces.js";
import type { Signature } from "starknet";
import { Signer } from "starknet";

/**
 * Subclass of starknet's Signer that exposes signRaw as public.
 * Use this when you have a private key and need to sign a precomputed hash
 * (e.g. for proof invocations) without re-hashing via signTransaction.
 *
 * @example
 * ```ts
 * import { SignerRaw } from "./internal/signer-raw.js";
 * const signer = new SignerRaw("0x...");
 * const sig = await signer.signRaw(txHash);
 * ```
 */
export class SignerRaw extends Signer implements SignerRawInterface {
  /** Public wrapper for the protected signRaw, so callers can sign a precomputed hash. */
  public override async signRaw(msgHash: string): Promise<Signature> {
    return super.signRaw(msgHash);
  }
}
