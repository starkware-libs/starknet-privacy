import { describe, it, expect } from "vitest";
import { hash } from "starknet";
import type { Call } from "starknet";
import {
  AvnuPaymaster,
  toPaymasterCall,
  normalizeSignature,
  type PaymasterFeeMode,
} from "../src/paymaster.js";

const FEE_MODE: PaymasterFeeMode = {
  mode: "sponsored_private",
  poolFeeToken: "0xfee",
  tip: "normal",
};
const POOL = "0xpool";

/** Records each JSON-RPC request and replies with `result` (or an `error` when configured). */
function mockFetch(
  result: unknown,
  opts?: { error?: { message: string; code: number; data?: unknown } }
) {
  const calls: Array<{ method: string; params: unknown; headers: Record<string, string> }> = [];
  const fetchFn = (async (
    _url: string,
    init: { headers: Record<string, string>; body: string }
  ) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, params: body.params, headers: init.headers });
    return {
      json: async () => (opts?.error ? { error: opts.error } : { result }),
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("toPaymasterCall / normalizeSignature", () => {
  it("maps a Call to selector + calldata wire shape", () => {
    const call: Call = { contractAddress: "0x1", entrypoint: "approve", calldata: ["0x2", "0x3"] };
    expect(toPaymasterCall(call)).toEqual({
      to: "0x1",
      selector: hash.getSelectorFromName("approve"),
      calldata: ["0x2", "0x3"],
    });
  });

  it("normalizes an array signature to hex felts matching the SNIP-29 FELT pattern", () => {
    const felts = normalizeSignature([1n, 2n] as unknown as string[]);
    expect(felts).toEqual(["0x1", "0x2"]);
    // Conformance to the FELT pattern SNIP-29/AVNU enforces (from @starknet-io/starknet-types):
    const SNIP29_FELT = /^0x(0|[a-fA-F1-9][a-fA-F0-9]{0,62})$/;
    for (const felt of felts) expect(felt).toMatch(SNIP29_FELT);
  });
});

describe("AvnuPaymaster", () => {
  it("buildTransaction (applyAction) sends the pool + fee mode and returns the fee quote", async () => {
    const feeAction = { type: "withdraw", recipient: "0xpm", token: "0xfee", amount: "0x2a" };
    const { fetchFn, calls } = mockFetch({ fee_action: feeAction });
    const pm = new AvnuPaymaster({
      url: "http://pm",
      feeMode: FEE_MODE,
      apiKey: "k",
      fetch: fetchFn,
    });

    const quote = await pm.buildTransaction({ kind: "applyAction", poolAddress: POOL });

    expect(quote.feeAction).toEqual(feeAction);
    expect(quote.typedData).toBeUndefined();
    expect(calls[0].method).toBe("paymaster_buildTransaction");
    expect(calls[0].headers["x-paymaster-api-key"]).toBe("k");
    expect(calls[0].params).toEqual({
      transaction: { type: "apply_action", apply_action: { pool_address: POOL } },
      parameters: {
        version: "0x1",
        fee_mode: { mode: "sponsored_private", pool_fee_token: "0xfee", tip: "normal" },
      },
    });
  });

  it("buildTransaction (invokeAndApplyAction) forwards the invoke calls and returns typed data", async () => {
    const feeAction = { type: "withdraw", recipient: "0xpm", token: "0xfee", amount: "0x1" };
    const typed_data = { domain: {}, types: {}, primaryType: "X", message: {} };
    const { fetchFn, calls } = mockFetch({ fee_action: feeAction, typed_data });
    const pm = new AvnuPaymaster({ url: "http://pm", feeMode: FEE_MODE, fetch: fetchFn });
    const approve = toPaymasterCall({
      contractAddress: "0xtok",
      entrypoint: "approve",
      calldata: ["0x1"],
    });

    const quote = await pm.buildTransaction({
      kind: "invokeAndApplyAction",
      poolAddress: POOL,
      userAddress: "0xuser",
      calls: [approve],
    });

    expect(quote.typedData).toEqual(typed_data);
    expect((calls[0].params as { transaction: { invoke: unknown } }).transaction.invoke).toEqual({
      user_address: "0xuser",
      calls: [approve],
    });
    expect(calls[0].headers["x-paymaster-api-key"]).toBeUndefined();
  });

  it("executeTransaction (applyAction) sends the proven call + proof and returns the tx hash", async () => {
    const { fetchFn, calls } = mockFetch({ transaction_hash: "0xdead" });
    const pm = new AvnuPaymaster({ url: "http://pm", feeMode: FEE_MODE, fetch: fetchFn });
    const applyActionsCall = { to: "0xpool", selector: "0xsel", calldata: ["0x0"] };

    const res = await pm.executeTransaction({
      kind: "applyAction",
      applyActionsCall,
      proof: "cafe",
      proofFacts: ["0x1", "0x2"],
    });

    expect(res.transactionHash).toBe("0xdead");
    expect(calls[0].method).toBe("paymaster_executeTransaction");
    expect(
      (calls[0].params as { transaction: { apply_action: unknown } }).transaction.apply_action
    ).toEqual({
      apply_actions_call: applyActionsCall,
      proof: "cafe",
      proof_facts: ["0x1", "0x2"],
    });
  });

  it("surfaces a paymaster JSON-RPC error with its execution_error detail", async () => {
    const { fetchFn } = mockFetch(null, {
      error: { message: "bad", code: -32000, data: { execution_error: "reverted: no funds" } },
    });
    const pm = new AvnuPaymaster({ url: "http://pm", feeMode: FEE_MODE, fetch: fetchFn });

    await expect(pm.buildTransaction({ kind: "applyAction", poolAddress: POOL })).rejects.toThrow(
      /paymaster_buildTransaction: bad \(code: -32000\): reverted: no funds/
    );
  });
});
