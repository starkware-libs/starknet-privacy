/**
 * Test-only signer for screening attestations.
 *
 * Produces the STARK-curve ECDSA signature over the SNIP-12 (revision 1)
 * typed-data message the privacy-pool contract verifies on-chain
 * (packages/privacy/src/snip12.cairo) for a regular-pool deposit. In production
 * this signature comes from the off-chain screener (the proving service relays
 * it); tests fabricate it here so the devnet suite can exercise the screening
 * path without a live screener.
 *
 * The message hash and signature stay byte-compatible with the canonical
 * cross-language vectors in fixtures/screening-vectors.json — screening-signer
 * test asserts this signer reproduces every committed vector.
 *
 * SNIP-12 revision-1 message hash:
 *   poseidon_hash_span([
 *     shortstring("StarkNet Message"),
 *     domain_hash,           // poseidon(DOMAIN_TYPE_HASH, name, version, chain_id, 1)
 *     signer_public_key,     // SNIP-12 "account" slot
 *     message_struct_hash,   // poseidon(DEPOSITOR_VALIDATION_TYPE_HASH, depositor, issued_at)
 *   ])
 */

import { ec } from "starknet";
import type { ScreeningSignature } from "../internal/proving-service.js";

/** A Cairo short string is its ASCII bytes read big-endian as a felt (<= 31 chars). */
function shortStringToFelt(text: string): bigint {
  return BigInt("0x" + Buffer.from(text, "ascii").toString("hex"));
}

const STARKNET_MESSAGE = shortStringToFelt("StarkNet Message");
// starknet_keccak of the SNIP-12 encodeType strings, pinned as felts so an
// encodeType edit can't silently shift the digest. The deployed Cairo verifier
// bakes in the same constants; the cross-language vectors reproduce them.
const STARKNET_DOMAIN_TYPE_HASH =
  0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210n;
const DEPOSITOR_VALIDATION_TYPE_HASH =
  0x32d43b7372c9ea8a35daf12b02c5f6f74837910ecbaf2a3ecfe71fec901913dn;
const DOMAIN_NAME = shortStringToFelt("Screening");
// Numeric felt (not the shortstring '2'), matching the on-chain verifier.
const DOMAIN_VERSION = 2n;
const DOMAIN_REVISION = 1n;

// The canonical screening signer keypair from fixtures/screening-vectors.json.
// The pool is deployed with this public key as its `screener_public_key`, and
// the signing mock proof provider signs deposits with this private key.
export const SCREENING_SIGNER_PRIVATE_KEY = "0xCAFEBABE";
export const SCREENING_SIGNER_PUBLIC_KEY = BigInt(
  ec.starkCurve.getStarkKey(SCREENING_SIGNER_PRIVATE_KEY)
);

/**
 * Recompute the SNIP-12 message hash the contract verifies. `chainId` and
 * `depositor` are field elements; `signerPublicKey` fills the SNIP-12 account
 * slot and is the key `check_ecdsa_signature` verifies against.
 */
export function computeScreeningMessageHash(
  chainId: bigint,
  depositor: bigint,
  issuedAt: bigint,
  signerPublicKey: bigint
): bigint {
  const domainHash = ec.starkCurve.poseidonHashMany([
    STARKNET_DOMAIN_TYPE_HASH,
    DOMAIN_NAME,
    DOMAIN_VERSION,
    chainId,
    DOMAIN_REVISION,
  ]);
  const messageStructHash = ec.starkCurve.poseidonHashMany([
    DEPOSITOR_VALIDATION_TYPE_HASH,
    depositor,
    issuedAt,
  ]);
  return ec.starkCurve.poseidonHashMany([
    STARKNET_MESSAGE,
    domainHash,
    signerPublicKey,
    messageStructHash,
  ]);
}

/**
 * Sign a screening attestation. `issuedAt` is unix seconds. The signer's public
 * key (derived from `privateKey`) fills the SNIP-12 account slot, so the
 * signature is bound to the exact key that verifies it on-chain.
 */
export function signScreeningAttestation(
  privateKey: string,
  chainId: bigint,
  depositor: bigint,
  issuedAt: number
): ScreeningSignature {
  const signerPublicKey = BigInt(ec.starkCurve.getStarkKey(privateKey));
  const messageHash = computeScreeningMessageHash(
    chainId,
    depositor,
    BigInt(issuedAt),
    signerPublicKey
  );
  const signature = ec.starkCurve.sign("0x" + messageHash.toString(16), privateKey);
  return {
    issued_at: issuedAt,
    sig_r: "0x" + signature.r.toString(16),
    sig_s: "0x" + signature.s.toString(16),
  };
}
