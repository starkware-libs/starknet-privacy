import { describe, it, expect } from "vitest";
import { hash } from "starknet";
import { SdkWallet } from "../src/index.js";
import type { Paymaster, Strk20Action } from "../src/index.js";
import type { Strk20Prover } from "../src/index.js";

const PROVEN = {
  call: { contract_address: "0xpool", entry_point: "apply_actions", calldata: ["0xc"] },
  proof: { data: "0xproofdata", output: ["0xo"], proof_facts: ["0xf1", "0xf2"] },
};

/** A prover double recording what it was asked to prove. */
function fakeProver(seen: { proved?: Strk20Action[] } = {}): Strk20Prover {
  return {
    partialCommitment: async (dappName) => (dappName === "my-dapp" ? 0xc0ffeen : 0n),
    prove: async (actions) => {
      seen.proved = actions;
      return PROVEN;
    },
  };
}

/** A paymaster double quoting a fixed fee and recording the execute request. */
function fakePaymaster(seen: { build?: unknown; execute?: unknown } = {}): Paymaster {
  return {
    buildTransaction: async (build) => {
      seen.build = build;
      return { feeAction: { type: "withdraw", recipient: "0xpm", token: "0xfee", amount: "0x2a" } };
    },
    executeTransaction: async (execute) => {
      seen.execute = execute;
      return { transactionHash: "0xsent" };
    },
  };
}

describe("SdkWallet", () => {
  it("partialCommitment and strk20PrepareInvoke delegate to the prover", async () => {
    const proverSeen: { proved?: Strk20Action[] } = {};
    const wallet = new SdkWallet({
      prover: fakeProver(proverSeen),
      paymaster: fakePaymaster(),
      poolContractAddress: "0xpool",
    });
    expect(await wallet.partialCommitment("my-dapp")).toBe(0xc0ffeen);

    const actions = [
      { type: "withdraw", token: "0x7", amount: "0x5", recipient: "0x9" },
    ] as Strk20Action[];
    const prepared = await wallet.strk20PrepareInvoke(actions);
    expect(proverSeen.proved).toBe(actions);
    expect(prepared).toBe(PROVEN);
  });

  it("strk20InvokeTransaction folds the quoted fee into the proof and broadcasts via the paymaster", async () => {
    const proverSeen: { proved?: Strk20Action[] } = {};
    const paymasterSeen: { build?: unknown; execute?: unknown } = {};
    const wallet = new SdkWallet({
      prover: fakeProver(proverSeen),
      paymaster: fakePaymaster(paymasterSeen),
      poolContractAddress: "0xpool",
    });
    const actions = [
      { type: "withdraw", token: "0x7", amount: "0x5", recipient: "0x9" },
    ] as Strk20Action[];

    const result = await wallet.strk20InvokeTransaction(actions);

    expect(paymasterSeen.build).toEqual({ kind: "applyAction", poolAddress: "0xpool" });
    // the fee withdraw is appended to the proven action set, so the proof covers it
    expect(proverSeen.proved).toEqual([
      ...actions,
      { type: "withdraw", token: "0xfee", amount: "0x2a", recipient: "0xpm" },
    ]);
    // the proven strk20 call is mapped to the paymaster wire shape (selector + calldata)
    expect(paymasterSeen.execute).toEqual({
      kind: "applyAction",
      applyActionsCall: {
        to: "0xpool",
        selector: hash.getSelectorFromName("apply_actions"),
        calldata: ["0xc"],
      },
      proof: "0xproofdata",
      proofFacts: ["0xf1", "0xf2"],
    });
    expect(result).toEqual({ transaction_hash: "0xsent" });
  });

  it("rejects the not-yet-implemented regular flow (executeWithProof / estimateInvokeFee)", async () => {
    const wallet = new SdkWallet({
      prover: fakeProver(),
      paymaster: fakePaymaster(),
      poolContractAddress: "0xpool",
    });
    await expect(wallet.executeWithProof([])).rejects.toThrow(/regular/);
    await expect(wallet.estimateInvokeFee()).rejects.toThrow(/not yet implemented/);
  });
});
