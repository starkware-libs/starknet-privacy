#!/usr/bin/env node
// Produce a screening attestation locally with the proxy's own signer.
// Reuses signScreening + computeScreeningMessageHash from dist/ so the digest
// and signature stay byte-identical to what the deployed /screen route emits —
// useful for debugging against the on-chain verifier or the canonical
// cross-language vectors (fixtures/screening-vectors.json at the repo root).
//
// Usage:
//   node scripts/local-sign.mjs <private-key> <chain-id> <depositor> [issued-at]
//
// issued-at defaults to now (unix seconds). The key is test/ops material —
// the production key never leaves the cloud function.
//
// Build first: `npm run build` (imports from dist/).

import { getStarkKey } from "@scure/starknet";
import { computeScreeningMessageHash, signScreening } from "../dist/signing.js";

const [, , privateKey, chainIdArg, depositorArg, issuedAtArg] = process.argv;
if (!privateKey || !chainIdArg || !depositorArg) {
  console.error(
    "usage: local-sign.mjs <private-key> <chain-id> <depositor> [issued-at]"
  );
  process.exit(2);
}

const chainId = BigInt(chainIdArg);
const depositor = BigInt(depositorArg);
const issuedAt = issuedAtArg
  ? Number(issuedAtArg)
  : Math.floor(Date.now() / 1000);

const signerPublicKey = BigInt(getStarkKey(privateKey));
const messageHash = computeScreeningMessageHash(
  chainId,
  depositor,
  BigInt(issuedAt),
  signerPublicKey
);
const signature = signScreening(privateKey, chainId, depositor, issuedAt);

console.log(
  JSON.stringify(
    {
      signer_public_key: "0x" + signerPublicKey.toString(16),
      message_hash: "0x" + messageHash.toString(16),
      ...signature,
    },
    null,
    2
  )
);
