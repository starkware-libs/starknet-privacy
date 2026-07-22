import { describe, it, expect } from "vitest";
import type { ProviderInterface } from "starknet";
import { createPrivacyClient } from "../src/index.js";
import type { PrivacyWallet } from "../src/index.js";

const provider = { tag: "provider" } as unknown as ProviderInterface;

/** A minimal {@link PrivacyWallet} double. */
function fakeWallet(): PrivacyWallet {
  return {
    partialCommitment: async () => 0n,
    strk20PrepareInvoke: async () => {
      throw new Error("unused");
    },
    strk20InvokeTransaction: async () => {
      throw new Error("unused");
    },
  };
}

describe("createPrivacyClient", () => {
  it("builds a client from a wallet + read context", () => {
    const client = createPrivacyClient({
      wallet: fakeWallet(),
      provider,
      subAccountAnonymizerAddress: 0x2n,
    });
    expect(client).toBeDefined();
  });
});
