// Generates the canonical screening-v2 signing reference vectors (PR F1).
//
// These vectors are the cross-language contract between:
//   - the off-chain signer (elliptic-proxy/src/signing.ts, PR O2), and
//   - the on-chain verifier (packages/privacy verify_screening_sig, PR C3).
// Both MUST reproduce the exact (digest, sig_r, sig_s) below for the given
// inputs. The committed JSON (tests/fixtures/screening-vectors.json) is the
// source of truth; regenerate with `node scripts/gen-screening-vectors.mjs`.
//
// Digest construction (frozen — see docs/spec/screening-v2.md §5.2):
//   digest = poseidonHashMany([domain_tag, chain_id, from_addr, signature_timestamp])
// poseidonHashMany (@scure/starknet) reproduces Cairo
//   core::poseidon::poseidon_hash_span(array![..].span()) — the convention the
// privacy pool already uses (packages/privacy hashes.cairo). The on-chain
// verifier (C3) MUST hash this exact 4-felt span; the committed vectors below
// are the cross-language arbiter.
//
// Signature: STARK-curve ECDSA (deterministic, RFC6979) over the digest.
// public_key is the x-only stark key — exactly what Cairo
//   ecdsa::check_ecdsa_signature(digest, public_key, sig_r, sig_s) consumes.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  poseidonHashMany,
  sign,
  verify,
  getStarkKey,
  getPublicKey,
} from "@scure/starknet";

// A Cairo short string ('SN_MAIN', 'screening_v2', ...) is its ASCII bytes read
// big-endian as a felt. 31-byte max; all strings here fit.
const shortStringToFelt = (text) =>
  BigInt("0x" + Buffer.from(text, "ascii").toString("hex"));

const toHex = (value) => "0x" + value.toString(16);

// Fixed dev signing key. MUST be 1 <= key < STARK curve order
// (n ≈ 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f).
// Test-only; the production key lives in the FPI cloud function.
const PRIVATE_KEY =
  "0x03e1f1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddee";

const DOMAIN_TAG = "screening_v2";

// (name, chain_id short string, from_addr, signature_timestamp)
const INPUTS = [
  {
    name: "sepolia_allowed",
    chainId: "SN_SEPOLIA",
    fromAddr:
      "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    signatureTimestamp: 1716579600,
  },
  {
    name: "mainnet_allowed",
    chainId: "SN_MAIN",
    fromAddr:
      "0x06f3a1e2c5d40b9a78e2417b3c2d1e0f00112233445566778899aabbccddeeff",
    signatureTimestamp: 1716580000,
  },
  {
    name: "sepolia_other_address",
    chainId: "SN_SEPOLIA",
    fromAddr:
      "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",
    signatureTimestamp: 1716579600,
  },
];

const domainFelt = shortStringToFelt(DOMAIN_TAG);
const publicKey = getStarkKey(PRIVATE_KEY); // x-only stark key (on-chain pubkey)
// Full uncompressed point (04 || x || y), hex — needed for off-chain @scure
// verify(), which (unlike Cairo) cannot verify against the x-only key.
const fullPublicKey =
  "0x" + Buffer.from(getPublicKey(PRIVATE_KEY)).toString("hex");

const vectors = INPUTS.map((input) => {
  const chainIdFelt = shortStringToFelt(input.chainId);
  const fromAddrFelt = BigInt(input.fromAddr);
  const timestampFelt = BigInt(input.signatureTimestamp);

  const digest = poseidonHashMany([
    domainFelt,
    chainIdFelt,
    fromAddrFelt,
    timestampFelt,
  ]);
  const signature = sign(toHex(digest), PRIVATE_KEY);

  // Sanity: the produced signature must verify against the full public key.
  if (!verify(signature, toHex(digest), fullPublicKey)) {
    throw new Error(`vector ${input.name} failed self-verification`);
  }

  return {
    name: input.name,
    chain_id_str: input.chainId,
    chain_id: toHex(chainIdFelt),
    from_addr: input.fromAddr,
    signature_timestamp: input.signatureTimestamp,
    digest: toHex(digest),
    sig_r: toHex(signature.r),
    sig_s: toHex(signature.s),
  };
});

const output = {
  _spec: {
    description:
      "Screening v2 signing reference vectors. Source of truth for the " +
      "off-chain signer (O2) and on-chain verifier (C3).",
    digest:
      "poseidonHashMany([domain_tag, chain_id, from_addr, signature_timestamp])",
    poseidon:
      "matches Cairo core::poseidon::poseidon_hash_span (NOT PoseidonTrait builder)",
    signature: "STARK-curve ECDSA, deterministic (RFC6979)",
    public_key_note:
      "public_key is the x-only stark key consumed by Cairo check_ecdsa_signature",
    regenerate: "node scripts/gen-screening-vectors.mjs",
  },
  domain_tag_str: DOMAIN_TAG,
  domain_tag: toHex(domainFelt),
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
