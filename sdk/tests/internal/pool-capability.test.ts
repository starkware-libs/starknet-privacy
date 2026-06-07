import { describe, it, expect, vi, afterEach } from "vitest";
import { RpcProvider } from "starknet";
import {
  isEntrypointNotFoundError,
  resolvePoolScreeningCapability,
} from "../../src/internal/pool-capability.js";
import { PoolCapabilityError } from "../../src/internal/errors.js";

const POOL_ADDRESS = "0x1234";

afterEach(() => vi.restoreAllMocks());

function mockCallContract(resolveValue: string[]) {
  return vi.spyOn(RpcProvider.prototype, "callContract").mockResolvedValue(resolveValue);
}

function mockCallContractReject(error: unknown) {
  return vi.spyOn(RpcProvider.prototype, "callContract").mockRejectedValue(error);
}

describe("resolvePoolScreeningCapability", () => {
  const rpc = new RpcProvider({ nodeUrl: "https://node.test" });

  it("returns 'screening' when screening_version returns a version >= 1", async () => {
    mockCallContract(["0x1"]);
    expect(await resolvePoolScreeningCapability(rpc, POOL_ADDRESS)).toBe("screening");
  });

  it("treats any version >= 1 as screening", async () => {
    mockCallContract(["0x7"]);
    expect(await resolvePoolScreeningCapability(rpc, POOL_ADDRESS)).toBe("screening");
  });

  it("returns 'compatibility' when the view exists but reports version 0", async () => {
    mockCallContract(["0x0"]);
    expect(await resolvePoolScreeningCapability(rpc, POOL_ADDRESS)).toBe("compatibility");
  });

  it("returns 'compatibility' for an empty result (defensive — view exists, no arity)", async () => {
    mockCallContract([]);
    expect(await resolvePoolScreeningCapability(rpc, POOL_ADDRESS)).toBe("compatibility");
  });

  it("returns 'compatibility' for an unparseable version felt (never throws on bad data)", async () => {
    mockCallContract(["not-a-felt"]);
    expect(await resolvePoolScreeningCapability(rpc, POOL_ADDRESS)).toBe("compatibility");
  });

  it("returns 'compatibility' on an entrypoint-not-found revert (current pool)", async () => {
    mockCallContractReject(
      new Error("Entry point EntryPointSelector(0xabc) not found in contract")
    );
    expect(await resolvePoolScreeningCapability(rpc, POOL_ADDRESS)).toBe("compatibility");
  });

  it("throws PoolCapabilityError on a transient RPC failure (does NOT assume compat)", async () => {
    mockCallContractReject(new Error("fetch failed: ECONNREFUSED"));
    await expect(resolvePoolScreeningCapability(rpc, POOL_ADDRESS)).rejects.toBeInstanceOf(
      PoolCapabilityError
    );
  });

  it("throws PoolCapabilityError on a timeout (does NOT assume compat)", async () => {
    mockCallContractReject(new Error("The operation timed out"));
    await expect(resolvePoolScreeningCapability(rpc, POOL_ADDRESS)).rejects.toBeInstanceOf(
      PoolCapabilityError
    );
  });
});

describe("isEntrypointNotFoundError", () => {
  it("matches the canonical ENTRYPOINT_NOT_FOUND token", () => {
    expect(isEntrypointNotFoundError(new Error("Transaction reverted: ENTRYPOINT_NOT_FOUND"))).toBe(
      true
    );
  });

  it("matches the 'not found in contract' phrasing", () => {
    expect(isEntrypointNotFoundError(new Error("Entry point 0x123 not found in contract."))).toBe(
      true
    );
  });

  it("matches the spaced 'Entry point ... not found' phrasing", () => {
    expect(isEntrypointNotFoundError(new Error("Entry point not found"))).toBe(true);
  });

  it("matches when the marker is nested in a structured error's data", () => {
    const rpcError = Object.assign(new Error("RPC: contract error"), {
      baseError: { data: "ENTRYPOINT_NOT_FOUND" },
    });
    expect(isEntrypointNotFoundError(rpcError)).toBe(true);
  });

  it("does not match unrelated failures (network, timeout, generic revert)", () => {
    expect(isEntrypointNotFoundError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isEntrypointNotFoundError(new Error("operation timed out"))).toBe(false);
    expect(isEntrypointNotFoundError(new Error("Insufficient balance"))).toBe(false);
  });

  it("does not throw on null/undefined/non-error inputs", () => {
    expect(isEntrypointNotFoundError(null)).toBe(false);
    expect(isEntrypointNotFoundError(undefined)).toBe(false);
    expect(isEntrypointNotFoundError(42)).toBe(false);
  });
});
