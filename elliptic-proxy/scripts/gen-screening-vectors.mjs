// Generates the screening signing reference vectors — the cross-language
// contract for the screening attestation. The off-chain signer
// (src/signing.ts) and the on-chain verifier (packages/privacy/src/snip12.cairo,
// verify_depositor_validation) must both reproduce every (message_hash, sig_r,
// sig_s) below for the given inputs. The committed JSON
// (tests/fixtures/screening-vectors.json) is the source of truth.
//
// Usage:
//   node scripts/gen-screening-vectors.mjs
//     -> rewrites tests/fixtures/screening-vectors.json
//   The script self-checks before writing: it asserts the StarknetDomain and
//   DepositorValidation type hashes equal the constants the on-chain verifier
//   uses, and that every signature verifies against the public key.
//
// Scheme: SNIP-12 revision 1 typed-data message, signed with STARK-curve ECDSA
// (deterministic, RFC6979). The message hash is:
//
//   message_hash = poseidon([
//     shortstring("StarkNet Message"),
//     domain_hash,             // poseidon(DOMAIN_TYPE_HASH, name, version, chain_id, 1)
//     signer_public_key,       // SNIP-12 "account" slot (OZ get_message_hash(signer))
//     message_struct_hash,     // poseidon(DEPOSITOR_VALIDATION_TYPE_HASH, depositor, issued_at)
//   ])
//
// where poseidon is poseidon_hash_span and each type hash is the starknet_keccak
// of its SNIP-12 revision-1 encodeType string (every identifier double-quoted).
// chain_id lives in the domain (replay separation across networks). The depositor
// (the screened deposit source) is bound as the DepositorValidation member; the
// account slot holds the signer's own x-only stark key, which is also the
// public_key the on-chain check_ecdsa_signature verifies against.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  keccak,
  poseidonHashMany,
  sign,
  verify,
  getStarkKey,
  getPublicKey,
} from "@scure/starknet";

const toHex = (value) => "0x" + value.toString(16);

// A Cairo short string is its ASCII bytes read big-endian as a felt (<= 31 chars).
const shortStringToFelt = (text) =>
  BigInt("0x" + Buffer.from(text, "ascii").toString("hex"));

// starknet_keccak: keccak-256 of the ASCII bytes, masked to 250 bits (@scure's
// keccak already applies the 250-bit mask).
const starknetKeccak = (text) => keccak(new TextEncoder().encode(text));

// SNIP-12 revision-1 encodeType strings (every identifier JSON double-quoted).
const DOMAIN_TYPE =
  '"StarknetDomain"("name":"shortstring","version":"shortstring","chainId":"shortstring","revision":"shortstring")';
const DEPOSITOR_VALIDATION_TYPE =
  '"DepositorValidation"("depositor":"ContractAddress","issued_at":"u128")';

const STARKNET_DOMAIN_TYPE_HASH = starknetKeccak(DOMAIN_TYPE);
const DEPOSITOR_VALIDATION_TYPE_HASH = starknetKeccak(DEPOSITOR_VALIDATION_TYPE);

// The StarknetDomain type hash is a published SNIP-12 revision-1 constant (also
// hardcoded in OpenZeppelin's Cairo snip12 utilities). The DepositorValidation
// type hash is the selector! constant in packages/privacy/src/snip12.cairo. If
// either assertion fails, the encodeType / starknet_keccak implementation is wrong.
const CANONICAL_DOMAIN_TYPE_HASH =
  0x1ff2f602e42168014d405a94f75e8a93d640751d71d16311266e140d8b0a210n;
const CANONICAL_DEPOSITOR_VALIDATION_TYPE_HASH =
  0x32d43b7372c9ea8a35daf12b02c5f6f74837910ecbaf2a3ecfe71fec901913dn;
if (STARKNET_DOMAIN_TYPE_HASH !== CANONICAL_DOMAIN_TYPE_HASH) {
  throw new Error(
    "StarknetDomain type hash mismatch — SNIP-12 encoding is wrong"
  );
}
if (DEPOSITOR_VALIDATION_TYPE_HASH !== CANONICAL_DEPOSITOR_VALIDATION_TYPE_HASH) {
  throw new Error(
    "DepositorValidation type hash mismatch — diverged from snip12.cairo"
  );
}

const STARKNET_MESSAGE = shortStringToFelt("StarkNet Message");
const DOMAIN_NAME = shortStringToFelt("Screening");
// Numeric felt (not the shortstring '2' = 0x32), matching the starknet.js /
// starknet-py domain-version convention the on-chain verifier follows.
const DOMAIN_VERSION = 2n;
const DOMAIN_REVISION = 1n; // SNIP-12 revision 1, encoded as the integer 1

// Fixed dev signing key. MUST be 1 <= key < STARK curve order
// (n ≈ 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f).
// Test-only; the production key lives in the FPI cloud function.
const PRIVATE_KEY =
  "0x03e1f1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddee";

const publicKey = getStarkKey(PRIVATE_KEY); // x-only stark key (on-chain pubkey)
const signerPublicKey = BigInt(publicKey); // fills the SNIP-12 account slot
// Full uncompressed point (04 || x || y), hex — needed for off-chain @scure
// verify(), which (unlike the on-chain verifier) cannot verify against the
// x-only key.
const fullPublicKey =
  "0x" + Buffer.from(getPublicKey(PRIVATE_KEY)).toString("hex");

// (name, chain_id short string, depositor, issued_at)
const INPUTS = [
  {
    name: "sepolia_allowed",
    chainId: "SN_SEPOLIA",
    depositor:
      "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    issuedAt: 1716579600,
  },
  {
    name: "mainnet_allowed",
    chainId: "SN_MAIN",
    depositor:
      "0x06f3a1e2c5d40b9a78e2417b3c2d1e0f00112233445566778899aabbccddeeff",
    issuedAt: 1716580000,
  },
  {
    name: "sepolia_other_address",
    chainId: "SN_SEPOLIA",
    depositor:
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",
    issuedAt: 1716579600,
  },
];

function domainHash(chainIdFelt) {
  return poseidonHashMany([
    STARKNET_DOMAIN_TYPE_HASH,
    DOMAIN_NAME,
    DOMAIN_VERSION,
    chainIdFelt,
    DOMAIN_REVISION,
  ]);
}

function messageHash(chainIdFelt, depositorFelt, issuedAtFelt) {
  const structHash = poseidonHashMany([
    DEPOSITOR_VALIDATION_TYPE_HASH,
    depositorFelt,
    issuedAtFelt,
  ]);
  return poseidonHashMany([
    STARKNET_MESSAGE,
    domainHash(chainIdFelt),
    signerPublicKey, // SNIP-12 account slot == the trusted signer's public key
    structHash,
  ]);
}

const vectors = INPUTS.map((input) => {
  const chainIdFelt = shortStringToFelt(input.chainId);
  const depositorFelt = BigInt(input.depositor);
  const issuedAtFelt = BigInt(input.issuedAt);

  const hash = messageHash(chainIdFelt, depositorFelt, issuedAtFelt);
  const signature = sign(toHex(hash), PRIVATE_KEY);

  // Sanity: the produced signature must verify against the full public key.
  if (!verify(signature, toHex(hash), fullPublicKey)) {
    throw new Error(`vector ${input.name} failed self-verification`);
  }

  return {
    name: input.name,
    chain_id_str: input.chainId,
    chain_id: toHex(chainIdFelt),
    depositor: input.depositor,
    issued_at: input.issuedAt,
    message_hash: toHex(hash),
    sig_r: toHex(signature.r),
    sig_s: toHex(signature.s),
  };
});

const output = {
  scheme: {
    standard:
      "SNIP-12 revision 1 typed-data message; STARK-curve ECDSA, deterministic (RFC6979)",
    message_hash:
      "poseidon_hash_span(['StarkNet Message', domain_hash, signer_public_key, message_struct_hash])",
    domain: { name: "Screening", version: 2, revision: 1 },
    message_type: DEPOSITOR_VALIDATION_TYPE,
    account_slot:
      "signer_public_key — the trusted signer's x-only stark key fills the SNIP-12 account slot (OZ get_message_hash(signer))",
    public_key_note:
      "public_key is the x-only stark key consumed by the on-chain check_ecdsa_signature, and also the account-slot value",
    regenerate: "node scripts/gen-screening-vectors.mjs",
  },
  starknet_message: toHex(STARKNET_MESSAGE),
  domain_name: "Screening",
  domain_version: 2,
  domain_revision: 1,
  starknet_domain_type_hash: toHex(STARKNET_DOMAIN_TYPE_HASH),
  depositor_validation_type_hash: toHex(DEPOSITOR_VALIDATION_TYPE_HASH),
  private_key: PRIVATE_KEY,
  public_key: publicKey,
  full_public_key: fullPublicKey,
  vectors,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "tests", "fixtures", "screening-vectors.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${outPath}`);
