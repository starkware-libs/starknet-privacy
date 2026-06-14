// src/signing.ts
//
// Screening attestation signer. Produces a STARK-curve ECDSA signature over a
// SNIP-12 (revision 1) typed-data message binding a deposit's source address,
// which the privacy-pool contract verifies on-chain
// (packages/privacy/src/snip12.cairo). The message hash and signature stay
// byte-compatible with the canonical cross-language vectors in
// fixtures/screening-vectors.json (regenerate with
// scripts/gen_screening_fixtures.py).
//
// SNIP-12 revision-1 message hash:
//   poseidon_hash_span([
//     shortstring("StarkNet Message"),
//     domain_hash,           // poseidon(DOMAIN_TYPE_HASH, name, version, chain_id, 1)
//     signer_public_key,     // SNIP-12 "account" slot (OZ get_message_hash(signer))
//     message_struct_hash,   // poseidon(DEPOSITOR_VALIDATION_TYPE_HASH, depositor, issued_at)
//   ])
// poseidonHashMany (@scure/starknet) is poseidon_hash_span; the type hashes are
// the starknet_keccak of the SNIP-12 encodeType strings, pinned as constants
// below and reproduced by the reference vectors.

import { poseidonHashMany, sign, getStarkKey } from "@scure/starknet";

/** A Cairo short string is its ASCII bytes read big-endian as a felt (<= 31 chars). */
function shortStringToFelt(text: string): bigint {
  return BigInt("0x" + Buffer.from(text, "ascii").toString("hex"));
}

const STARKNET_MESSAGE = shortStringToFelt("StarkNet Message");
// The two type hashes below are pinned felts, deliberately not derived at
// runtime from their encodeType strings: the deployed Cairo verifier bakes
// the same values in at compile time, so a runtime derivation would let an
// encodeType edit silently shift the digest into something self-consistent
// off-chain but rejected on-chain (the unit tests re-derive and assert them).
//
// starknet_keccak("StarknetDomain"("name":"shortstring","version":"shortstring",
// "chainId":"shortstring","revision":"shortstring")) — the canonical SNIP-12
// revision-1 domain type hash (also hardcoded in OZ's Cairo snip12 utilities).
export const STARKNET_DOMAIN_TYPE_HASH =
  0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210n;
// starknet_keccak('"DepositorValidation"("depositor":"ContractAddress","issued_at":"u128")')
export const DEPOSITOR_VALIDATION_TYPE_HASH =
  0x32d43b7372c9ea8a35daf12b02c5f6f74837910ecbaf2a3ecfe71fec901913dn;
const DOMAIN_NAME = shortStringToFelt("Screening");
// Numeric felt (not the shortstring '2' = 0x32), matching the starknet.js /
// starknet-py domain-version convention the on-chain verifier follows.
const DOMAIN_VERSION = 2n;
const DOMAIN_REVISION = 1n; // SNIP-12 revision 1, encoded as the integer 1

/** Wire shape returned to the caller and packed into apply_actions calldata. */
export interface ScreeningSignature {
  issued_at: number;
  sig_r: string;
  sig_s: string;
}

/**
 * Recompute the SNIP-12 message hash the contract will verify. `chainId` and
 * `depositor` are field elements (the contract derives chain_id from
 * get_tx_info and `depositor` from the proven TransferFrom action), and
 * `signerPublicKey` is the trusted signer's x-only stark key, which fills the
 * SNIP-12 account slot and is the key check_ecdsa_signature verifies against.
 */
export function computeScreeningMessageHash(
  chainId: bigint,
  depositor: bigint,
  issuedAt: bigint,
  signerPublicKey: bigint
): bigint {
  const domainHash = poseidonHashMany([
    STARKNET_DOMAIN_TYPE_HASH,
    DOMAIN_NAME,
    DOMAIN_VERSION,
    chainId,
    DOMAIN_REVISION,
  ]);
  const messageStructHash = poseidonHashMany([
    DEPOSITOR_VALIDATION_TYPE_HASH,
    depositor,
    issuedAt,
  ]);
  return poseidonHashMany([
    STARKNET_MESSAGE,
    domainHash,
    signerPublicKey,
    messageStructHash,
  ]);
}

/**
 * Sign a screening attestation. `issuedAt` is unix seconds. The signer's public
 * key (derived from `privateKey`) fills the SNIP-12 account slot, so a signature
 * is bound to the exact key that will verify it on-chain.
 *
 * Throws if the message hash is >= 2**251 (the STARK ECDSA message bound) — a
 * negligibly rare Poseidon output that the contract would also reject. Callers
 * treat a throw as a transient signing failure (fail closed).
 */
export function signScreening(
  privateKey: string,
  chainId: bigint,
  depositor: bigint,
  issuedAt: number
): ScreeningSignature {
  const signerPublicKey = BigInt(getStarkKey(privateKey));
  const messageHash = computeScreeningMessageHash(
    chainId,
    depositor,
    BigInt(issuedAt),
    signerPublicKey
  );
  const signature = sign("0x" + messageHash.toString(16), privateKey);
  return {
    issued_at: issuedAt,
    sig_r: "0x" + signature.r.toString(16),
    sig_s: "0x" + signature.s.toString(16),
  };
}
