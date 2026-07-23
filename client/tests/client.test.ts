import { describe, it, expect } from "vitest";
import type {
  Call,
  EstimateFeeResponseOverhead,
  ProviderInterface,
  STRK20_CALL_AND_PROOF,
  STRK20_PROOF,
} from "starknet";
import { createPrivacyClient } from "../src/index.js";
import type { PrivacyWallet, Strk20Action } from "../src/index.js";

const provider = { tag: "provider" } as unknown as ProviderInterface;

/** Records every seam call so tests can assert which wallet path a submit took. */
interface Seen {
  invoke?: Strk20Action[];
  prepare?: [Strk20Action[], boolean | undefined];
  execute?: [Call[], STRK20_PROOF | undefined];
  estimate?: Call[];
}

const preparedProof = { data: "0xproof", output: [], proof_facts: [] } as STRK20_PROOF;
const feeEstimate = { overall_fee: 42n } as unknown as EstimateFeeResponseOverhead;

/** A {@link PrivacyWallet} double whose prepared call is a fixed snake_case strk20 call. */
function fakeWallet(seen: Seen = {}): PrivacyWallet {
  return {
    partialCommitment: async () => 0n,
    strk20PrepareInvoke: async (actions, simulate) => {
      seen.prepare = [actions, simulate];
      return {
        call: { contract_address: "0xpool", entry_point: "apply", calldata: ["0x1"] },
        proof: preparedProof,
      } as STRK20_CALL_AND_PROOF;
    },
    strk20InvokeTransaction: async (actions) => {
      seen.invoke = actions;
      return { transaction_hash: "0xfast" };
    },
    executeWithProof: async (calls, proof) => {
      seen.execute = [calls, proof];
      return { transaction_hash: "0xwrapped" };
    },
    estimateInvokeFee: async (calls) => {
      seen.estimate = calls;
      return feeEstimate;
    },
  };
}

function client(seen: Seen = {}) {
  return createPrivacyClient({
    wallet: fakeWallet(seen),
    provider,
    subAccountAnonymizerAddress: 0x2n,
  });
}

const actions = [{ type: "withdraw" }] as unknown as Strk20Action[];
const mappedCall = { contractAddress: "0xpool", entrypoint: "apply", calldata: ["0x1"] };

describe("createPrivacyClient", () => {
  it("builds a client from a wallet + read context", () => {
    expect(client()).toBeDefined();
  });
});

describe("submit", () => {
  it("with no surrounding calls uses the combined strk20InvokeTransaction", async () => {
    const seen: Seen = {};
    const result = await client(seen).submit(actions);
    expect(result).toEqual({ transaction_hash: "0xfast" });
    expect(seen.invoke).toBe(actions);
    expect(seen.prepare).toBeUndefined();
    expect(seen.execute).toBeUndefined();
  });

  it("with preCalls/postCalls prepares then executeWithProof over the assembled, mapped calls", async () => {
    const seen: Seen = {};
    const pre = { contractAddress: "0xtoken", entrypoint: "approve", calldata: ["0x9"] };
    const post = { contractAddress: "0xother", entrypoint: "ping" };
    const result = await client(seen).submit(actions, { preCalls: [pre], postCalls: [post] });
    expect(result).toEqual({ transaction_hash: "0xwrapped" });
    expect(seen.prepare).toEqual([actions, false]);
    const [calls, proof] = seen.execute!;
    // pre, the mapped strk20 call (snake→camel), then post.
    expect(calls).toEqual([pre, mappedCall, post]);
    expect(proof).toBe(preparedProof);
  });

  it("with simulate:true prepares in simulate mode and estimates the assembled invoke's fee", async () => {
    const seen: Seen = {};
    const estimate = await client(seen).submit(actions, { simulate: true });
    expect(estimate).toBe(feeEstimate);
    expect(seen.prepare).toEqual([actions, true]);
    expect(seen.estimate).toEqual([mappedCall]);
    expect(seen.invoke).toBeUndefined();
    expect(seen.execute).toBeUndefined();
  });
});
