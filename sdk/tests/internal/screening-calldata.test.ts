import { describe, expect, it } from "vitest";
import { screeningCalldataSuffix } from "../../src/internal/screening-calldata.js";
import type { ScreeningSignature } from "../../src/internal/proving-service.js";

const SIGNATURE: ScreeningSignature = {
  issued_at: 1716579600,
  sig_r: "0x6e6f63c8",
  sig_s: "0x58a68a71",
};

// 1716579600 in hex.
const ISSUED_AT_FELT = "0x6650ed10";

// Cairo's Option Serde: Some=0, None=1.
describe("screeningCalldataSuffix", () => {
  it("encodes a missing additional_data as Option::None ([0x1])", () => {
    expect(screeningCalldataSuffix(undefined)).toEqual(["0x1"]);
  });

  it("encodes additional_data without a signature as Option::None ([0x1])", () => {
    expect(screeningCalldataSuffix({})).toEqual(["0x1"]);
  });

  it("encodes a signature as Option::Some ([0x0]) with hex issued_at and verbatim felts", () => {
    expect(screeningCalldataSuffix({ signature: SIGNATURE })).toEqual([
      "0x0",
      ISSUED_AT_FELT,
      SIGNATURE.sig_r,
      SIGNATURE.sig_s,
    ]);
  });
});
