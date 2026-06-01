import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScreeningMessageHash, signScreening } from "../src/signing.js";

// The committed reference vectors are the cross-language contract: the signer
// here and the on-chain verifier must both reproduce them exactly.
// Regenerate with `node scripts/gen-screening-vectors.mjs`.
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
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
  private_key: string;
  public_key: string;
  vectors: Vector[];
};

const signerPublicKey = BigInt(fixture.public_key);

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
        fixture.private_key,
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
