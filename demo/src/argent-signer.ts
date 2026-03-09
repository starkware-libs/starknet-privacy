/**
 * Minimal Argent account signer (owner-only, no guardian).
 *
 * Produces the Argent signature format:
 *   [1, ...CallData.compile(CairoCustomEnum({ Starknet: { signer, r, s }, ... }))]
 *
 * Vendored from argentlabs/argent-contracts-starknet (no npm package available).
 * Only supports V3 transactions with accounts deployed with guardian = 0.
 */
import { Signer, CallData, CairoCustomEnum, ec, type Signature } from "starknet";

export class ArgentOwnerSigner extends Signer {
  protected override async signRaw(messageHash: string): Promise<Signature> {
    const signature = ec.starkCurve.sign(messageHash, this.pk as string);
    const publicKey = ec.starkCurve.getStarkKey(this.pk as string);

    const signerEnum = new CairoCustomEnum({
      Starknet: { signer: BigInt(publicKey), r: signature.r, s: signature.s },
      Secp256k1: undefined,
      Secp256r1: undefined,
      Eip191: undefined,
      Webauthn: undefined,
    });

    return ["1", ...CallData.compile([signerEnum])];
  }
}
