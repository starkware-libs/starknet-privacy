import { describe, it, expect } from "vitest";
import { cairo, hash, num } from "starknet";
import type { TypedData } from "starknet";
import { SdkWallet } from "../src/index.js";
import type { Paymaster, Strk20Action, Strk20Prover } from "../src/index.js";

const PROVEN = {
  call: { contract_address: "0xpool", entry_point: "apply_actions", calldata: ["0xc"] },
  proof: { data: "0xproofdata", output: ["0xo"], proof_facts: ["0xf1", "0xf2"] },
};
const TYPED_DATA = { domain: {}, types: {}, primaryType: "X", message: {} } as unknown as TypedData;

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

/** A paymaster double quoting a fixed fee (and typed data for the invoke case). */
function fakePaymaster(seen: { build?: unknown; execute?: unknown } = {}): Paymaster {
  return {
    buildTransaction: async (build) => {
      seen.build = build;
      return {
        feeAction: { type: "withdraw", recipient: "0xpm", token: "0xfee", amount: "0x2a" },
        typedData: TYPED_DATA,
      };
    },
    executeTransaction: async (execute) => {
      seen.execute = execute;
      return { transactionHash: "0xsent" };
    },
  };
}

function makeWallet(
  proverSeen: { proved?: Strk20Action[] } = {},
  paymasterSeen: { build?: unknown; execute?: unknown } = {},
  signed: { typedData?: TypedData; account?: string } = {}
) {
  return new SdkWallet({
    prover: fakeProver(proverSeen),
    paymaster: fakePaymaster(paymasterSeen),
    poolContractAddress: "0xpool",
    userAddress: "0xuser",
    signer: {
      signMessage: async (typedData, account) => {
        signed.typedData = typedData;
        signed.account = account;
        return ["0x1", "0x2"];
      },
    } as never,
  });
}

const withdrawActions = [
  { type: "withdraw", token: "0x7", amount: "0x5", recipient: "0x9" },
] as Strk20Action[];

describe("SdkWallet", () => {
  it("partialCommitment and strk20PrepareInvoke delegate to the prover", async () => {
    const proverSeen: { proved?: Strk20Action[] } = {};
    const wallet = makeWallet(proverSeen);
    expect(await wallet.partialCommitment("my-dapp")).toBe(0xc0ffeen);
    const prepared = await wallet.strk20PrepareInvoke(withdrawActions);
    expect(proverSeen.proved).toBe(withdrawActions);
    expect(prepared).toBe(PROVEN);
  });

  it("private flow: no deposit → apply_action, fee folded into the proof, broadcast via paymaster", async () => {
    const proverSeen: { proved?: Strk20Action[] } = {};
    const paymasterSeen: { build?: unknown; execute?: unknown } = {};
    const result = await makeWallet(proverSeen, paymasterSeen).strk20InvokeTransaction(
      withdrawActions
    );

    expect(paymasterSeen.build).toEqual({ kind: "applyAction", poolAddress: "0xpool" });
    expect(proverSeen.proved).toEqual([
      ...withdrawActions,
      { type: "withdraw", token: "0xfee", amount: "0x2a", recipient: "0xpm" },
    ]);
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

  it("regular flow: a deposit → invoke_and_apply_action with a signed approve", async () => {
    const paymasterSeen: { build?: unknown; execute?: unknown } = {};
    const signed: { typedData?: TypedData; account?: string } = {};
    const actions = [{ type: "deposit", token: "0xtok", amount: "0x64" }] as Strk20Action[];
    const amount = cairo.uint256(0x64n);
    const expectedApprove = {
      to: "0xtok",
      selector: hash.getSelectorFromName("approve"),
      calldata: ["0xpool", num.toHex(amount.low), num.toHex(amount.high)],
    };

    const result = await makeWallet({}, paymasterSeen, signed).strk20InvokeTransaction(actions);

    // build switches to the regular flow, carrying the user-signed approve
    expect(paymasterSeen.build).toEqual({
      kind: "invokeAndApplyAction",
      poolAddress: "0xpool",
      userAddress: "0xuser",
      calls: [expectedApprove],
    });
    // the user signs the paymaster's typed data for their own account
    expect(signed.typedData).toBe(TYPED_DATA);
    expect(signed.account).toBe("0xuser");
    expect(paymasterSeen.execute).toEqual({
      kind: "invokeAndApplyAction",
      applyActionsCall: {
        to: "0xpool",
        selector: hash.getSelectorFromName("apply_actions"),
        calldata: ["0xc"],
      },
      proof: "0xproofdata",
      proofFacts: ["0xf1", "0xf2"],
      userAddress: "0xuser",
      typedData: TYPED_DATA,
      signature: ["0x1", "0x2"],
    });
    expect(result).toEqual({ transaction_hash: "0xsent" });
  });

  it("rejects the unsupported pre-proved surrounding-calls / estimate paths", async () => {
    const wallet = makeWallet();
    await expect(wallet.executeWithProof([])).rejects.toThrow(/not supported/);
    await expect(wallet.estimateInvokeFee()).rejects.toThrow(/not yet implemented/);
  });
});
