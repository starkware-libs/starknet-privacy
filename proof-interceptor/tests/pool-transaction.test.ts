// tests/pool-transaction.test.ts
import { describe, it, expect } from "vitest";
import {
  decodeClientActions,
  isSinglePoolCall,
} from "../src/pool-transaction.js";
import {
  AMOUNT,
  POOL_ADDR,
  PRIVATE_KEY,
  TOKEN,
  USER_ADDR,
  depositAction,
  poolCallTransaction,
  rawPoolCallTransaction,
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

  it("survives an unparseable viewing key, keeping the rest of the decode", () => {
    // The key felt is caller-controlled and only shadow account derivation reads it. Voiding the
    // whole decode over it would drop the transaction out of screening altogether, which for a
    // deposit means letting it through unscreened. `screened-address.test.ts` pins that end.
    const transaction = poolCallTransaction([depositAction()]);
    transaction.calldata[5] = "not-a-felt";

    const poolCall = decodeClientActions(transaction, POOL_ADDR);
    expect(poolCall?.userAddress).toBe(USER_ADDR);
    expect(poolCall?.viewingKey).toBeNull();
  });
});

describe("decodeClientActions on raw calldata", () => {
  it("decodes user_addr from a deposit transaction", () => {
    const poolCall = decodeClientActions(rawPoolCallTransaction(), POOL_ADDR);
    expect(poolCall?.userAddress).toBe(USER_ADDR);
  });

  it("returns empty when contract address does not match pool address", () => {
    const poolCall = decodeClientActions(rawPoolCallTransaction(), "0xother");
    expect(poolCall).toBeNull();
  });

  it("matches pool address regardless of leading zeros", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction([
        "0x1",
        "0x00000abc",
        "0xsel",
        "0x6",
        USER_ADDR,
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      "0xabc"
    );
    expect(poolCall?.userAddress).toBe(USER_ADDR);
  });

  it("returns empty for short calldata", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction(["0x1", POOL_ADDR, "0xsel"]),
      POOL_ADDR
    );
    expect(poolCall).toBeNull();
  });

  it("normalizes addresses by stripping leading zeros", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction([
        "0x1",
        POOL_ADDR,
        "0xsel",
        "0x6",
        "0x00004a1b2c",
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      POOL_ADDR
    );
    expect(poolCall?.userAddress).toBe("0x4a1b2c");
  });

  it("normalizes all-zero address to 0x0", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction([
        "0x1",
        POOL_ADDR,
        "0xsel",
        "0x6",
        "0x0000000000",
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      POOL_ADDR
    );
    expect(poolCall?.userAddress).toBe("0x0");
  });

  it("returns empty when inner_calldata_len is too small", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction(["0x1", POOL_ADDR, "0xsel", "0x2", "0x1", "0x2"]),
      POOL_ADDR
    );
    expect(poolCall).toBeNull();
  });

  it("returns empty when inner_calldata_len is not valid hex", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction(["0x1", POOL_ADDR, "0xsel", "not-hex", "0x1"]),
      POOL_ADDR
    );
    expect(poolCall).toBeNull();
  });

  it("handles address without 0x prefix", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction([
        "0x1",
        POOL_ADDR,
        "0xsel",
        "0x6",
        "4a1b2c",
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      POOL_ADDR
    );
    expect(poolCall?.userAddress).toBe("0x4a1b2c");
  });

  it("returns empty when calldata[0] is not 0x1", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction(["0x2", POOL_ADDR, "0xsel", "0x6", "0x1"]),
      POOL_ADDR
    );
    expect(poolCall).toBeNull();
  });

  // Attackers must not be able to dodge the single-pool-call check by
  // submitting equivalent encodings of 1 (uppercase prefix, leading zeros,
  // bare "1" with no prefix). All of these are the same felt value.
  it.each([["0X1"], ["0x01"], ["0x001"], ["0x0001"], ["1"]])(
    "treats %s as a single-call count (no normalization bypass)",
    (callCount) => {
      const poolCall = decodeClientActions(
        rawPoolCallTransaction([
          callCount,
          POOL_ADDR,
          "0xselector",
          "0x6",
          USER_ADDR,
          PRIVATE_KEY,
          "0x1",
          "0x5",
          TOKEN,
          AMOUNT,
        ]),
        POOL_ADDR
      );
      expect(poolCall?.userAddress).toBe(USER_ADDR);
    }
  );

  it("matches pool address regardless of 0X vs 0x prefix casing", () => {
    const poolCall = decodeClientActions(
      rawPoolCallTransaction([
        "0x1",
        "0XABC",
        "0xselector",
        "0x6",
        USER_ADDR,
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]),
      "0xabc"
    );
    expect(poolCall?.userAddress).toBe(USER_ADDR);
  });

  describe("deposit-only screening", () => {
    it("decodes a transaction whose only action is SetViewingKey", () => {
      const poolCall = decodeClientActions(
        rawPoolCallTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x5",
          USER_ADDR,
          PRIVATE_KEY,
          "0x1", // 1 action
          "0x0", // SetViewingKey
          "0xabc", // random
        ]),
        POOL_ADDR
      );
      expect(poolCall?.actions.map((action) => action.activeVariant())).toEqual(
        ["SetViewingKey"]
      );
    });

    it("decodes a transaction whose only action is Withdraw", () => {
      const poolCall = decodeClientActions(
        rawPoolCallTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x8",
          USER_ADDR,
          PRIVATE_KEY,
          "0x1", // 1 action
          "0x7", // Withdraw
          "0x111", // to_addr
          TOKEN,
          AMOUNT,
          "0xabc", // random
        ]),
        POOL_ADDR
      );
      expect(poolCall?.actions.map((action) => action.activeVariant())).toEqual(
        ["Withdraw"]
      );
    });

    it("decodes user_addr when a deposit follows other actions", () => {
      const poolCall = decodeClientActions(
        rawPoolCallTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x8",
          USER_ADDR,
          PRIVATE_KEY,
          "0x2", // 2 actions
          "0x0", // SetViewingKey
          "0xabc",
          "0x5", // Deposit
          TOKEN,
          AMOUNT,
        ]),
        POOL_ADDR
      );
      expect(poolCall?.userAddress).toBe(USER_ADDR);
    });

    it("decodes user_addr past an InvokeExternal action", () => {
      const poolCall = decodeClientActions(
        rawPoolCallTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0xc",
          USER_ADDR,
          PRIVATE_KEY,
          "0x2", // 2 actions
          "0x8", // InvokeExternal
          "0x222", // contract_address
          "0x2",
          "0xa",
          "0xb", // Span<felt252> len=2
          "0x5", // Deposit
          TOKEN,
          AMOUNT,
        ]),
        POOL_ADDR
      );
      expect(poolCall?.userAddress).toBe(USER_ADDR);
    });

    it("decodes a transaction carrying no actions", () => {
      const poolCall = decodeClientActions(
        rawPoolCallTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x3",
          USER_ADDR,
          PRIVATE_KEY,
          "0x0", // 0 actions
        ]),
        POOL_ADDR
      );
      expect(poolCall?.actions.map((action) => action.activeVariant())).toEqual(
        []
      );
    });

    it("returns null on malformed calldata, so nothing is screened", () => {
      const poolCall = decodeClientActions(
        rawPoolCallTransaction([
          "0x1",
          POOL_ADDR,
          "0xsel",
          "0x4",
          USER_ADDR,
          PRIVATE_KEY,
          "0x1", // 1 action
          "0xff", // invalid variant index
        ]),
        POOL_ADDR
      );
      expect(poolCall).toBeNull();
    });
  });
});

describe("isSinglePoolCall", () => {
  it("returns true for a single-call INVOKE targeting the pool", () => {
    expect(isSinglePoolCall(rawPoolCallTransaction(), POOL_ADDR)).toBe(true);
  });

  it("returns false when the target contract is not the pool", () => {
    expect(isSinglePoolCall(rawPoolCallTransaction(), "0xother")).toBe(false);
  });

  it("returns false for multi-call transactions", () => {
    const transaction = rawPoolCallTransaction([
      "0x2", // 2 calls
      POOL_ADDR,
      "0xsel",
      "0x0",
      "0xother",
      "0xsel",
      "0x0",
    ]);
    expect(isSinglePoolCall(transaction, POOL_ADDR)).toBe(false);
  });

  it("returns false for short calldata", () => {
    expect(
      isSinglePoolCall(
        rawPoolCallTransaction(["0x1", POOL_ADDR, "0xsel"]),
        POOL_ADDR
      )
    ).toBe(false);
  });

  it.each([["0X1"], ["0x01"], ["0x001"]])(
    "returns true when call_count is %s (normalized to 0x1)",
    (callCount) => {
      const transaction = rawPoolCallTransaction([
        callCount,
        POOL_ADDR,
        "0xsel",
        "0x6",
        USER_ADDR,
        PRIVATE_KEY,
        "0x1",
        "0x5",
        TOKEN,
        AMOUNT,
      ]);
      expect(isSinglePoolCall(transaction, POOL_ADDR)).toBe(true);
    }
  );
});
