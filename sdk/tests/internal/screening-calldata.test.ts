import { describe, expect, it } from "vitest";
import { screeningCalldataSuffix } from "../../src/internal/screening-calldata.js";
import type { ScreeningSignature } from "../../src/interfaces.js";

// Cairo `Option` Serde uses the active-variant index first: Some = 0, None = 1
// (corelib declaration order). The suffix must match what `apply_actions` deserializes.
const SIGNATURE: ScreeningSignature = {
  issued_at: 1_716_579_600,
  sig_r: "0x6e6f63c8",
  sig_s: "0x58a68a71",
};
const ISSUED_AT_FELT = "0x6650ed10"; // 1716579600 in hex

describe("screeningCalldataSuffix", () => {
  it("encodes missing additionalData as Option::None ([0x1])", () => {
    expect(screeningCalldataSuffix(undefined)).toEqual(["0x1"]);
  });

  it("encodes additionalData without a signature as Option::None ([0x1])", () => {
    expect(screeningCalldataSuffix({})).toEqual(["0x1"]);
  });

  it("encodes a signature as Option::Some ([0x0, issued_at, sig_r, sig_s])", () => {
    expect(screeningCalldataSuffix({ signature: SIGNATURE })).toEqual([
      "0x0",
      ISSUED_AT_FELT,
      SIGNATURE.sig_r,
      SIGNATURE.sig_s,
    ]);
  });
});
