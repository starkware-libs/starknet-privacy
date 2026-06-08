import { describe, expect, it } from "vitest";
import { buildErc20Transfer, buildEthTransfer } from "./eth-send";

// Reference vector hand-computed from the ABI encoding rules:
//   selector       = keccak256("transfer(address,uint256)")[0..4] = 0xa9059cbb
//   recipient pad  = address lowercased, no 0x, left-padded to 32 bytes
//   amount    pad  = uint256 hex, left-padded to 32 bytes
const REFERENCE_TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const REFERENCE_AMOUNT = 1_000_000n; // 1 USDC (6 decimals)
const REFERENCE_CALLDATA =
  "0xa9059cbb" +
  "00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8" +
  "00000000000000000000000000000000000000000000000000000000000f4240";

describe("buildErc20Transfer", () => {
  it("produces canonical 0xa9059cbb calldata for a known (to, amount) pair", () => {
    const tx = buildErc20Transfer({
      token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      to: REFERENCE_TO,
      amount: REFERENCE_AMOUNT,
    });
    expect(tx.to).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(tx.data).toBe(REFERENCE_CALLDATA);
  });

  it("zero amount still emits the full 68-byte calldata", () => {
    const tx = buildErc20Transfer({
      token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      to: REFERENCE_TO,
      amount: 0n,
    });
    // 4 selector bytes + 32 address + 32 amount = 68 bytes = 136 hex chars + 0x.
    expect(tx.data).toHaveLength(2 + 8 + 64 + 64);
    expect(tx.data.endsWith("0".repeat(64))).toBe(true);
  });

  it("max uint256 encodes without overflow", () => {
    const maxU256 = (1n << 256n) - 1n;
    const tx = buildErc20Transfer({
      token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      to: REFERENCE_TO,
      amount: maxU256,
    });
    expect(tx.data.slice(-64)).toBe("f".repeat(64));
  });
});

describe("buildEthTransfer", () => {
  it("returns the target address and hex-encoded value", () => {
    const tx = buildEthTransfer({
      to: REFERENCE_TO,
      valueWei: 1_500_000_000_000_000_000n, // 1.5 ETH
    });
    expect(tx.to).toBe(REFERENCE_TO);
    expect(tx.value).toBe("0x14d1120d7b160000");
  });

  it("encodes zero as 0x0 (not empty)", () => {
    const tx = buildEthTransfer({ to: REFERENCE_TO, valueWei: 0n });
    expect(tx.value).toBe("0x0");
  });
});
