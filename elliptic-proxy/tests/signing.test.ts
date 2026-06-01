import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak } from "@scure/starknet";
import {
  computeScreeningMessageHash,
  signScreening,
  DEPOSITOR_VALIDATION_TYPE_HASH,
  STARKNET_DOMAIN_TYPE_HASH,
} from "../src/signing.js";

// The committed reference vectors are the cross-language contract: the signer
// here, the reference TS signer that produced them, and the on-chain Cairo
// verifier must all reproduce them exactly. Single producer: regenerate with
// `scripts/gen_screening_fixtures.py` (shells out to
// `scripts/address_validation_signer/ts/validation_signer.ts`).
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "screening-vectors.json"
);

interface Vector {
  name: string;
  chain_id: string;
  depositor: string;
  issued_at: number;
  message_hash: string;
  sig_r: string;
  sig_s: string;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  signer_private_key: string;
  signer_public_key: string;
  vectors: Vector[];
};

const signerPublicKey = BigInt(fixture.signer_public_key);

// The signer pins both type hashes as felts (the deployed verifier freezes
// them at compile time). Re-derive each from its SNIP-12 encodeType string so
// the pinned constants keep an executable provenance.
describe("pinned type hashes derive from their encodeType strings", () => {
  const snKeccak = (text: string) => keccak(new TextEncoder().encode(text));

  it("STARKNET_DOMAIN_TYPE_HASH is sn_keccak of the StarknetDomain type", () => {
    expect(
      snKeccak(
        '"StarknetDomain"("name":"shortstring","version":"shortstring","chainId":"shortstring","revision":"shortstring")'
      )
    ).toBe(STARKNET_DOMAIN_TYPE_HASH);
  });

  it("DEPOSITOR_VALIDATION_TYPE_HASH is sn_keccak of the DepositorValidation type", () => {
    expect(
      snKeccak(
        '"DepositorValidation"("depositor":"ContractAddress","issued_at":"u128")'
      )
    ).toBe(DEPOSITOR_VALIDATION_TYPE_HASH);
  });
});

describe("screening signer reproduces the reference vectors", () => {
  it("has vectors to check", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  for (const vector of fixture.vectors) {
    it(`message hash matches for ${vector.name}`, () => {
      const messageHash = computeScreeningMessageHash(
        BigInt(vector.chain_id),
        BigInt(vector.depositor),
        BigInt(vector.issued_at),
        signerPublicKey
      );
      expect("0x" + messageHash.toString(16)).toBe(vector.message_hash);
    });

    it(`signature matches for ${vector.name}`, () => {
      const signature = signScreening(
        fixture.signer_private_key,
        BigInt(vector.chain_id),
        BigInt(vector.depositor),
        vector.issued_at
      );
      expect(signature).toEqual({
        issued_at: vector.issued_at,
        sig_r: vector.sig_r,
        sig_s: vector.sig_s,
      });
    });
  }

  it("a different depositor yields a different message hash (binding)", () => {
    const base = fixture.vectors[0];
    const hashA = computeScreeningMessageHash(
      BigInt(base.chain_id),
      BigInt(base.depositor),
      BigInt(base.issued_at),
      signerPublicKey
    );
    const hashB = computeScreeningMessageHash(
      BigInt(base.chain_id),
      BigInt(base.depositor) + 1n,
      BigInt(base.issued_at),
      signerPublicKey
    );
    expect(hashA).not.toBe(hashB);
  });
});
