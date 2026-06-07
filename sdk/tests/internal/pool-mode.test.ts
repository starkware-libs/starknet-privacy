import { describe, it, expect } from "vitest";
import {
  COMPATIBILITY_POOL_CLASS_HASHES,
  poolModeForClassHash,
} from "../../src/internal/pool-mode.js";
import { toHex } from "../../src/utils/convert.js";

const PINNED_CLASS_HASH = toHex(COMPATIBILITY_POOL_CLASS_HASHES[0]);

describe("poolModeForClassHash", () => {
  it("selects compatibility for a pinned deployed-pool class hash", () => {
    expect(poolModeForClassHash(PINNED_CLASS_HASH)).toBe("compatibility");
  });

  it("matches a pinned hash on the canonical felt (zero-padded form)", () => {
    const paddedClassHash = "0x" + PINNED_CLASS_HASH.slice(2).padStart(64, "0");
    expect(poolModeForClassHash(paddedClassHash)).toBe("compatibility");
  });

  it("selects screening for any unpinned class hash", () => {
    expect(poolModeForClassHash("0x123abc")).toBe("screening");
  });

  it("selects compatibility for a missing class hash", () => {
    expect(poolModeForClassHash(undefined)).toBe("compatibility");
  });

  it("selects compatibility for an unparseable class hash felt", () => {
    expect(poolModeForClassHash("not-a-felt")).toBe("compatibility");
  });
});
