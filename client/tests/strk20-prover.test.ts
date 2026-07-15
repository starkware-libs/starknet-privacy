import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the operations the prover replays onto the core builder by faking createPrivateTransfers.
const h = vi.hoisted(() => {
  const coreCallAndProof = {
    call: { contractAddress: "0xpool", entrypoint: "apply", calldata: ["0x1"] },
    proof: { data: "0xdata", output: ["0x2"], proofFacts: ["0x3"] },
  };
  const state: {
    ops: Array<Record<string, unknown>>;
    buildOptions?: Record<string, unknown>;
    saved?: unknown;
    simulateArg?: unknown;
  } = { ops: [] };

  const tokenOps = (token: unknown) => ({
    deposit(input: unknown) {
      state.ops.push({ op: "deposit", token, input });
      return this;
    },
    withdraw(output: unknown) {
      state.ops.push({ op: "withdraw", token, output });
      return this;
    },
    transfer(output: unknown) {
      state.ops.push({ op: "transfer", token, output });
      return this;
    },
  });
  const builder = {
    with: (token: unknown) => tokenOps(token),
    invoke(callBuilder: unknown) {
      state.ops.push({ op: "invoke", callBuilder });
      return builder;
    },
    computeAndInvoke(callBuilder: unknown) {
      state.ops.push({ op: "computeAndInvoke", callBuilder });
      return builder;
    },
    execute: async () => ({ callAndProof: coreCallAndProof, registry: { tag: "saved-registry" } }),
    simulate: async (arg: unknown) => {
      state.simulateArg = arg;
      return { callAndProof: coreCallAndProof, registry: {} };
    },
    // subaccounts now hangs off the builder (core #905: transfers.build().subaccounts(...)).
    subaccounts: (dappName: string) => ({
      partialCommitment: async () => (dappName === "my-dapp" ? 0xc0ffeen : 0n),
      invoke: (nonce: unknown, options: unknown) => {
        state.ops.push({ op: "subaccountInvoke", dappName, nonce, options });
        return builder;
      },
    }),
  };
  const transfers = {
    build(options: Record<string, unknown>) {
      state.buildOptions = options;
      return builder;
    },
  };
  return { state, coreCallAndProof, createPrivateTransfers: () => transfers };
});

vi.mock("@starkware-libs/starknet-privacy-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@starkware-libs/starknet-privacy-sdk")>()),
  createPrivateTransfers: h.createPrivateTransfers,
}));

const { Open } = await import("@starkware-libs/starknet-privacy-sdk");
const { CorePrivateTransfersProver } = await import("../src/index.js");
import type { Strk20Action } from "../src/index.js";

const loadedRegistry = { tag: "loaded-registry" };
let saved: unknown;

function makeProver() {
  saved = undefined;
  return new CorePrivateTransfersProver({
    signer: {} as never,
    address: "0xacc",
    passphrase: "correct horse",
    provider: {} as never,
    discovery: {} as never,
    prover: {} as never,
    poolContractAddress: "0xpool",
    subAccountAnonymizerAddress: "0xanon",
    storage: {
      loadRegistry: async () => loadedRegistry as never,
      saveRegistry: async (registry) => {
        saved = registry;
      },
    },
  });
}

beforeEach(() => {
  h.state.ops = [];
  h.state.buildOptions = undefined;
  h.state.simulateArg = undefined;
});

describe("CorePrivateTransfersProver", () => {
  it("partialCommitment delegates to the core subaccounts builder for the dapp", async () => {
    expect(await makeProver().partialCommitment("my-dapp")).toBe(0xc0ffeen);
  });

  it("translates each strk20 action onto the core builder and maps the proof to strk20 shape", async () => {
    const actions: Strk20Action[] = [
      { type: "deposit", token: "0xt", amount: "0x64" },
      { type: "withdraw", token: "0xt", amount: "0xa", recipient: "0xr" },
      { type: "transfer", token: "0xt", amount: "OPEN", recipient: "0xr" },
      { type: "transfer", token: "0xt", amount: "0x5", recipient: "0xr2" },
    ];
    const result = await makeProver().prove(actions);

    expect(h.state.ops).toEqual([
      { op: "deposit", token: "0xt", input: { amount: 100n } },
      { op: "withdraw", token: "0xt", output: { recipient: "0xr", amount: 10n } },
      { op: "transfer", token: "0xt", output: { recipient: "0xr", amount: Open } },
      { op: "transfer", token: "0xt", output: { recipient: "0xr2", amount: 5n } },
    ]);
    // core CallAndProof (camelCase) → strk20 RPC shape (snake_case, proof_facts).
    expect(result).toEqual({
      call: { contract_address: "0xpool", entry_point: "apply", calldata: ["0x1"] },
      proof: { data: "0xdata", output: ["0x2"], proof_facts: ["0x3"] },
    });
  });

  it("loads the registry into build and saves the updated one after a real proof", async () => {
    await makeProver().prove([{ type: "deposit", token: "0xt", amount: "0x1" }]);
    expect(h.state.buildOptions).toMatchObject({
      autoRegister: true,
      autoSetup: true,
      autoSelectNotes: "naive",
      registry: loadedRegistry,
    });
    expect(saved).toEqual({ tag: "saved-registry" });
  });

  it("simulate estimates through the node provider and does not save the registry", async () => {
    const estimate = await makeProver().prove(
      [{ type: "deposit", token: "0xt", amount: "0x1" }],
      true
    );
    expect(h.state.simulateArg).toBeDefined();
    expect(saved).toBeUndefined();
    expect(estimate.call.contract_address).toBe("0xpool");
  });

  it("resolves invoke placeholders against the compiled transaction's open notes and pool", async () => {
    await makeProver().prove([
      { type: "transfer", token: "0xt", amount: "OPEN", recipient: "0xr" },
      {
        type: "invoke",
        contract: "0xdapp",
        calldata: ["0x5", "${openNoteIds[0]}", "${poolAddress}"],
      },
    ]);
    const invoke = h.state.ops.find((op) => op.op === "invoke")!;
    const callBuilder = invoke.callBuilder as (args: unknown) => {
      contractAddress: string;
      calldata: string[];
    };
    const built = callBuilder({
      openNotes: [{ noteId: 0xaan, token: 0xabcn }],
      withdrawals: [],
      poolAddress: 0xdeadn,
    });
    expect(built.contractAddress).toBe("0xdapp");
    expect(built.calldata).toEqual(["0x5", "0xaa", "0xdead"]);
  });

  it("maps compute_and_invoke to the core compute/invoke additional data with substitution", async () => {
    await makeProver().prove([
      {
        type: "compute_and_invoke",
        contract: "0xdapp",
        compute_calldata: ["${poolAddress}"],
        invoke_calldata: ["0x7"],
      },
    ]);
    const op = h.state.ops.find((entry) => entry.op === "computeAndInvoke")!;
    const callBuilder = op.callBuilder as (args: unknown) => {
      contractAddress: string;
      computeAdditionalData: string[];
      invokeAdditionalData: string[];
    };
    const built = callBuilder({ openNotes: [], withdrawals: [], poolAddress: 0xdeadn });
    expect(built).toEqual({
      contractAddress: "0xdapp",
      computeAdditionalData: ["0xdead"],
      invokeAdditionalData: ["0x7"],
    });
  });

  it("maps subaccount_invoke to core build().subaccounts(dappName).invoke with camelCase calls", async () => {
    await makeProver().prove([
      {
        type: "subaccount_invoke",
        dapp_name: "ekubo",
        nonce: "0x3",
        calls: [{ contract_address: "0xswap", entry_point: "swap", calldata: ["0x1"] }],
        collect_policy: { type: "exact", amount: "0x64" },
      },
    ]);
    const op = h.state.ops.find((entry) => entry.op === "subaccountInvoke")!;
    expect(op.dappName).toBe("ekubo");
    expect(op.nonce).toBe("0x3");
    expect(op.options).toEqual({
      calls: [{ contractAddress: "0xswap", entrypoint: "swap", calldata: ["0x1"] }],
      collectPolicy: { type: "exact", amount: 0x64n },
    });
  });
});
