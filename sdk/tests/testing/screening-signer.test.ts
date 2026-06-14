import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeScreeningMessageHash,
  signScreeningAttestation,
  SCREENING_SIGNER_PRIVATE_KEY,
  SCREENING_SIGNER_PUBLIC_KEY,
} from "../../src/testing/screening-signer.js";

// The committed cross-language vectors: the contract between the reference
// Python signer, this signer, and the Cairo verifier (packages/privacy). Each
// vector binds {chain_id, depositor, issued_at} to a message hash + signature
// under the fixture's signer key.
interface ScreeningVector {
  name: string;
  chain_id: string;
  depositor: string;
  issued_at: number;
  message_hash: string;
  sig_r: string;
  sig_s: string;
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../fixtures/screening-vectors.json", import.meta.url), "utf8")
) as {
  signer_private_key: string;
  signer_public_key: string;
  vectors: ScreeningVector[];
};

describe("screening-signer", () => {
  it("uses the fixture's signer keypair", () => {
    expect(SCREENING_SIGNER_PRIVATE_KEY.toLowerCase()).toBe(
      FIXTURE.signer_private_key.toLowerCase()
    );
    expect(SCREENING_SIGNER_PUBLIC_KEY).toBe(BigInt(FIXTURE.signer_public_key));
  });

  it("reproduces the committed message hash for every vector", () => {
    for (const vector of FIXTURE.vectors) {
      const messageHash = computeScreeningMessageHash(
        BigInt(vector.chain_id),
        BigInt(vector.depositor),
        BigInt(vector.issued_at),
        BigInt(FIXTURE.signer_public_key)
      );
      expect("0x" + messageHash.toString(16)).toBe("0x" + BigInt(vector.message_hash).toString(16));
    }
  });

  it("reproduces the committed signature for every vector", () => {
    for (const vector of FIXTURE.vectors) {
      const signature = signScreeningAttestation(
        FIXTURE.signer_private_key,
        BigInt(vector.chain_id),
        BigInt(vector.depositor),
        vector.issued_at
      );
      expect(signature.issued_at).toBe(vector.issued_at);
      expect(BigInt(signature.sig_r)).toBe(BigInt(vector.sig_r));
      expect(BigInt(signature.sig_s)).toBe(BigInt(vector.sig_s));
    }
  });

  it("signs arbitrary (non-vector) inputs with the right issued_at and hex felts", () => {
    const signature = signScreeningAttestation(
      SCREENING_SIGNER_PRIVATE_KEY,
      BigInt("0x534e5f5345504f4c4941"),
      BigInt("0xabc123"),
      1_800_000_000
    );
    expect(signature.issued_at).toBe(1_800_000_000);
    expect(signature.sig_r).toMatch(/^0x[0-9a-f]+$/);
    expect(signature.sig_s).toMatch(/^0x[0-9a-f]+$/);
  });
});
