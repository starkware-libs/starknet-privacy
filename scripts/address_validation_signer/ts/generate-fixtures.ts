// Emits the committed cross-language screening vectors. The reference TS signer
// (validation_signer.ts) is the single producer; the privacy contract's Cairo
// verifier tests consume the resulting fixtures/screening-vectors.json (rendered
// to Cairo by scripts/gen_cairo_screening_vectors.mjs). It is also the intended
// vector source for the off-chain screening signer. Signing is deterministic
// (RFC6979), so this is idempotent — CI fails if the committed fixture drifts.
//   npm run gen-fixtures
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ec, num, shortString } from "starknet";
import { signDepositorValidation } from "./validation_signer.ts";

// Test-only reference signing key — never a production key.
const SIGNER_PRIVATE_KEY = "0xCAFEBABE";

const INPUTS = [
  { name: "test_vector", depositor: "0x1234", issuedAt: 1700000000, chainId: "TEST" },
  {
    name: "sepolia_deposit",
    depositor: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
    issuedAt: 1716579600,
    chainId: "SN_SEPOLIA",
  },
  {
    name: "mainnet_deposit",
    depositor: "0x06f3a1e2c5d40b9a78e2417b3c2d1e0f00112233445566778899aabbccddeeff",
    issuedAt: 1716580000,
    chainId: "SN_MAIN",
  },
];

const sign = (input: { depositor: string; issuedAt: number; chainId: string }) =>
  signDepositorValidation({ signerPrivateKey: SIGNER_PRIVATE_KEY, ...input });

const vectors = INPUTS.map(({ name, ...input }) => {
  const signed = sign(input);
  return {
    name,
    chain_id_str: input.chainId,
    chain_id: num.toHex(shortString.encodeShortString(input.chainId)),
    depositor: signed.input.depositor,
    issued_at: input.issuedAt,
    message_hash: signed.messageHash,
    sig_r: signed.signature.r,
    sig_s: signed.signature.s,
  };
});

const output = {
  scheme: "SNIP-12 revision 1 DepositorValidation; STARK-curve ECDSA (RFC6979)",
  signer_private_key: SIGNER_PRIVATE_KEY,
  // The public key depends only on the private key, not on any message.
  signer_public_key: num.toHex(ec.starkCurve.getStarkKey(SIGNER_PRIVATE_KEY)),
  vectors,
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const outPath = join(repoRoot, "fixtures", "screening-vectors.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors -> ${outPath}`);
