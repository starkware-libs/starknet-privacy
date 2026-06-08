// Scope guard for the hackathon demo. If we ever expand the catalog, this
// test fails — forcing an intentional update + a matching review of the
// EVM_CHAINS set in useSourceWallet.
import { describe, it, expect } from "vitest";
import { DESTINATION_TOKENS, SOURCE_TOKEN } from "./tokens";

describe("token catalog scope", () => {
  it("source is STRK on Starknet only", () => {
    expect(SOURCE_TOKEN.id).toBe("strk-starknet");
    expect(SOURCE_TOKEN.chainTag).toBe("starknet");
  });

  it("exposes exactly the three scoped destinations", () => {
    expect(DESTINATION_TOKENS.map((t) => t.id).sort()).toEqual([
      "eth-ethereum",
      "sol-solana",
      "usdc-ethereum",
    ]);
  });

  it("each destination has a non-Starknet chainTag matching a 1Click chain", () => {
    const allowed = new Set(["eth", "sol"]);
    for (const t of DESTINATION_TOKENS) {
      expect(allowed.has(t.chainTag)).toBe(true);
    }
  });
});
