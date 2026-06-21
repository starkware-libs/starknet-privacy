import { describe, expect, it } from "vitest";
import { ec, num, shortString } from "starknet";
import type { Call, InvocationsSignerDetails } from "starknet";
import {
  Snip12CallSetSigner,
  computeCallSetHash,
} from "../../src/signers/snip12-call-set-signer.js";

// Same vector as packages/privacy/src/tests/test_snip12.cairo `sample_calls` + TEST_CHAIN_ID, so the
// two sides pin the same cross-layer golden.
const CHAIN_ID = shortString.encodeShortString("TEST");
const ACCOUNT = 0x1234n;
const SAMPLE_CALLS: Call[] = [
  { contractAddress: "0x111", entrypoint: "approve", calldata: ["0x1", "0x2"] },
];

// The value Cairo `compute_call_set_hash` asserts for the same vector
// (test_snip12.cairo::test_call_set_hash_matches_sdk_golden_vector).
const GOLDEN = "0x6a52fa6cde079f7c08b013d30d6560b411ede871c177c5f4072c66531cb4e39";

describe("Snip12CallSetSigner", () => {
  it("computeCallSetHash matches the Cairo golden vector (L2<->L3)", () => {
    expect(num.toHex(computeCallSetHash(ACCOUNT, SAMPLE_CALLS, CHAIN_ID))).toBe(GOLDEN);
  });

  it("signTransaction signs the CallSet hash; the signature verifies against the account key", async () => {
    const privateKey = "0x1234567890abcdef";
    const publicKey = ec.starkCurve.getPublicKey(privateKey); // full pubkey (verify needs both coords)
    const signer = new Snip12CallSetSigner({
      accountAddress: ACCOUNT,
      chainId: CHAIN_ID,
      sign: (h) => ec.starkCurve.sign(num.toHex(h), privateKey),
    });

    const sig = await signer.signTransaction(SAMPLE_CALLS, {} as InvocationsSignerDetails);
    const expectedHash = computeCallSetHash(ACCOUNT, SAMPLE_CALLS, CHAIN_ID);

    // The signer must sign exactly the CallSet hash with the account's key.
    expect(ec.starkCurve.verify(sig as never, num.toHex(expectedHash), publicKey)).toBe(true);
    // ...and not the empty-calls hash (proves the calls were bound).
    const otherHash = computeCallSetHash(ACCOUNT, [], CHAIN_ID);
    expect(ec.starkCurve.verify(sig as never, num.toHex(otherHash), publicKey)).toBe(false);
  });

  it("binds the calls (different call set -> different hash)", () => {
    expect(computeCallSetHash(ACCOUNT, SAMPLE_CALLS, CHAIN_ID)).not.toBe(
      computeCallSetHash(ACCOUNT, [], CHAIN_ID)
    );
  });

  it("binds the signer account (different account -> different hash)", () => {
    expect(computeCallSetHash(0x1n, SAMPLE_CALLS, CHAIN_ID)).not.toBe(
      computeCallSetHash(0x2n, SAMPLE_CALLS, CHAIN_ID)
    );
  });

  it("binds the chain id (different chain -> different hash)", () => {
    expect(computeCallSetHash(ACCOUNT, SAMPLE_CALLS, CHAIN_ID)).not.toBe(
      computeCallSetHash(ACCOUNT, SAMPLE_CALLS, shortString.encodeShortString("SN_MAIN"))
    );
  });
});
