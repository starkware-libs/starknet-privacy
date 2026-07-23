import { describe, expect, it } from "vitest";
import { ec, num, shortString, typedData } from "starknet";
import type { Call, InvocationsSignerDetails, TypedData } from "starknet";
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

// The value Cairo `compute_call_set_hash` asserts for the same vector (empty additional_data)
// (test_snip12.cairo::test_call_set_hash_matches_sdk_golden_vector).
const GOLDEN = "0x79d05f5b8993f5a0a18c6f7001e4d573c3eb97f322f6008cc1420f4f611501f";

// A stand-in for the paymaster's approve typed data the deposit flow asks the user to sign.
const SAMPLE_TYPED_DATA: TypedData = {
  domain: { name: "Privacy", version: "1", chainId: "TEST", revision: "1" },
  primaryType: "Approve",
  types: {
    StarknetDomain: [
      { name: "name", type: "shortstring" },
      { name: "version", type: "shortstring" },
      { name: "chainId", type: "shortstring" },
      { name: "revision", type: "shortstring" },
    ],
    Approve: [
      { name: "spender", type: "ContractAddress" },
      { name: "amount", type: "u128" },
    ],
  },
  message: { spender: "0x111", amount: "0x64" },
};

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

  it("signMessage signs the SNIP-12 typed-data hash with the account key (e.g. the paymaster approve)", async () => {
    const privateKey = "0x1234567890abcdef";
    const publicKey = ec.starkCurve.getPublicKey(privateKey);
    const account = num.toHex(ACCOUNT);
    const signer = new Snip12CallSetSigner({
      accountAddress: ACCOUNT,
      chainId: CHAIN_ID,
      sign: (h) => ec.starkCurve.sign(num.toHex(h), privateKey),
    });

    const sig = await signer.signMessage(SAMPLE_TYPED_DATA, account);
    const expectedHash = typedData.getMessageHash(SAMPLE_TYPED_DATA, account);

    // Signs exactly the message's SNIP-12 hash with the account key.
    expect(ec.starkCurve.verify(sig as never, expectedHash, publicKey)).toBe(true);
    // ...bound to the signing account: the same message hashed for another account does not verify.
    const otherHash = typedData.getMessageHash(SAMPLE_TYPED_DATA, "0x9999");
    expect(ec.starkCurve.verify(sig as never, otherHash, publicKey)).toBe(false);
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

  it("binds additional_data (empty vs non-empty, and differing values -> different hash)", () => {
    const empty = computeCallSetHash(ACCOUNT, SAMPLE_CALLS, CHAIN_ID);
    const withData = computeCallSetHash(ACCOUNT, SAMPLE_CALLS, CHAIN_ID, [0xan, 0xbn]);
    const otherData = computeCallSetHash(ACCOUNT, SAMPLE_CALLS, CHAIN_ID, [0xan, 0xcn]);
    expect(withData).not.toBe(empty);
    expect(withData).not.toBe(otherData);
  });
});
