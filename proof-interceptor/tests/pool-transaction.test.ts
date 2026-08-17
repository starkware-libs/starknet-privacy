// tests/pool-transaction.test.ts
import { describe, it, expect } from "vitest";
import { decodeClientActions } from "../src/pool-transaction.js";
import { getScreenedAddresses } from "../src/screening-interceptor.js";
import {
  POOL_ADDR,
  PRIVATE_KEY,
  USER_ADDR,
  depositAction,
  poolCallTransaction,
} from "./pool-call.js";

describe("decodeClientActions", () => {
  it("decodes the user address and the actions of a pool call", () => {
    const poolCall = decodeClientActions(
      poolCallTransaction([depositAction()]),
      POOL_ADDR
    );
    expect(poolCall?.userAddress).toBe(USER_ADDR);
    expect(poolCall?.actions.map((action) => action.activeVariant())).toEqual([
      "Deposit",
    ]);
  });

  it("returns null for a call to another contract", () => {
    const transaction = poolCallTransaction([depositAction()]);
    expect(decodeClientActions(transaction, "0x4321")).toBeNull();
  });

  it("carries the viewing key the pool derives identity keys from", () => {
    const poolCall = decodeClientActions(
      poolCallTransaction([depositAction()]),
      POOL_ADDR
    );
    expect(poolCall?.viewingKey).toBe(BigInt(PRIVATE_KEY));
  });

  it("still screens the deposit when only the viewing key is unparseable", () => {
    // The key felt is caller-controlled, and only shadow account derivation reads it. Voiding the
    // whole decode over it would drop the transaction out of screening altogether, which for a
    // deposit means letting it through unscreened.
    const transaction = poolCallTransaction([depositAction()]);
    transaction.calldata[5] = "not-a-felt";

    const poolCall = decodeClientActions(transaction, POOL_ADDR);
    expect(poolCall?.userAddress).toBe(USER_ADDR);
    expect(poolCall?.viewingKey).toBeNull();
    expect(getScreenedAddresses(transaction, POOL_ADDR)).toEqual([USER_ADDR]);
  });
});
