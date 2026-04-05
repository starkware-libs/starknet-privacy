// tests/interceptor.test.ts
import { describe, it, expect } from "vitest";
import {
  runInterceptors,
  type TransactionInterceptor,
  type Verdict,
} from "../src/interceptor.js";
import type { ProveTxnV3 } from "../src/types.js";

const sampleTransaction = {
  type: "INVOKE",
  version: "0x3",
  sender_address: "0x123",
  calldata: ["0x1"],
  signature: ["0x2"],
  nonce: "0x0",
  resource_bounds: {},
  tip: "0x0",
  paymaster_data: [],
  account_deployment_data: [],
  nonce_data_availability_mode: "L1",
  fee_data_availability_mode: "L1",
} as unknown as ProveTxnV3;

function allowAll(): TransactionInterceptor {
  return { name: "allow-all", intercept: async () => ({ action: "allow" }) };
}

function blockWith(reason: string): TransactionInterceptor {
  return {
    name: "blocker",
    intercept: async () => ({ action: "block", reason }),
  };
}

function delayedAllow(delayMs: number): TransactionInterceptor {
  return {
    name: "delayed-allow",
    intercept: () =>
      new Promise<Verdict>((resolve) =>
        setTimeout(() => resolve({ action: "allow" }), delayMs)
      ),
  };
}

function delayedBlock(delayMs: number, reason: string): TransactionInterceptor {
  return {
    name: "delayed-block",
    intercept: () =>
      new Promise<Verdict>((resolve) =>
        setTimeout(() => resolve({ action: "block", reason }), delayMs)
      ),
  };
}

function throwing(message: string): TransactionInterceptor {
  return {
    name: "thrower",
    intercept: async () => {
      throw new Error(message);
    },
  };
}

describe("runInterceptors", () => {
  it("returns allow when no interceptors", async () => {
    const result = await runInterceptors([], sampleTransaction);
    expect(result.action).toBe("allow");
  });

  it("returns allow when all interceptors allow", async () => {
    const result = await runInterceptors(
      [allowAll(), allowAll(), allowAll()],
      sampleTransaction
    );
    expect(result.action).toBe("allow");
  });

  it("returns block when one interceptor blocks", async () => {
    const result = await runInterceptors(
      [blockWith("sanctioned address")],
      sampleTransaction
    );
    expect(result).toEqual({
      action: "block",
      reason: "sanctioned address",
    });
  });

  it("returns block when any interceptor blocks among many", async () => {
    const result = await runInterceptors(
      [allowAll(), blockWith("bad actor"), allowAll()],
      sampleTransaction
    );
    expect(result.action).toBe("block");
  });

  it("treats thrown errors as block", async () => {
    const result = await runInterceptors(
      [throwing("connection failed")],
      sampleTransaction
    );
    expect(result).toEqual({
      action: "block",
      reason: "connection failed",
    });
  });

  it("returns block immediately on first block (does not wait for slow interceptors)", async () => {
    const start = Date.now();
    const result = await runInterceptors(
      [delayedBlock(0, "fast block"), delayedAllow(5000)],
      sampleTransaction
    );
    const elapsed = Date.now() - start;

    expect(result.action).toBe("block");
    expect(elapsed).toBeLessThan(1000); // Should not wait for the 5s interceptor
  });

  it("returns block even when slow block races against fast allows", async () => {
    const result = await runInterceptors(
      [allowAll(), allowAll(), delayedBlock(50, "slow block")],
      sampleTransaction
    );
    expect(result).toEqual({ action: "block", reason: "slow block" });
  });

  it("passes the transaction to each interceptor", async () => {
    let receivedTransaction: ProveTxnV3 | null = null;
    const capturing: TransactionInterceptor = {
      name: "capturing",
      intercept: async (tx) => {
        receivedTransaction = tx;
        return { action: "allow" };
      },
    };

    await runInterceptors([capturing], sampleTransaction);
    expect(receivedTransaction).toBe(sampleTransaction);
  });
});
