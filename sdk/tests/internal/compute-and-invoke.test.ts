/**
 * Tests for ComputeAndInvoke: the builder queues at most one invoke-phase action, and the
 * MockPoolContract simulate flow mirrors Cairo's compute_and_invoke — it queries the target's
 * privacy_compute with the derived identity key + computeData, then forwards the result +
 * invokeData to privacy_invoke_with_computation.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { createTestEnv, MockTestEnv } from "../helpers/test-fixtures.js";
import { MockContract } from "../../src/testing/contracts.js";
import { toBigInt, toHex } from "../../src/utils/index.js";
import { compute_identity_key } from "../../src/utils/hashes.js";
import { StarknetAddress } from "../../src/interfaces.js";

const COMPUTED_MARKER = 0xc0ffeen;

class MockComputeContract implements MockContract {
  [key: string]: unknown;
  public computeCalls: bigint[][] = [];
  public invokeCalls: bigint[][] = [];

  constructor(public address: StarknetAddress) {}

  // MockContracts.call spreads the flat calldata span as positional args.
  privacy_compute(...calldata: bigint[]): bigint {
    this.computeCalls.push(calldata);
    return COMPUTED_MARKER;
  }

  privacy_invoke_with_computation(...calldata: bigint[]): void {
    this.invokeCalls.push(calldata);
  }
}

describe("ComputeAndInvoke", () => {
  let testEnv: MockTestEnv;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  it("simulate flow prepends identity key to computeData and compute result to invokeData", async () => {
    const { mocknet, env, transfers } = testEnv;
    const compute = new MockComputeContract("0xC0FFEE");
    env.contracts.register(compute);

    mocknet.executeOutside(await transfers.alice.build().register().execute());

    const computeData = [7n, 8n];
    const invokeData = [42n];
    mocknet.executeOutside(
      await transfers.alice
        .build({ autoDiscover: { channels: "refresh", notes: "refresh" } })
        .computeAndInvoke(() => ({
          contractAddress: toHex(compute.address),
          computeData,
          invokeData,
        }))
        .execute()
    );

    const identityKey = compute_identity_key(
      toBigInt(env.alice.address),
      toBigInt(env.alice.privateKey),
      toBigInt(compute.address)
    );

    expect(compute.computeCalls).toEqual([[identityKey, ...computeData]]);
    expect(compute.invokeCalls).toEqual([[COMPUTED_MARKER, ...invokeData]]);
  });

  it("computeAndInvoke after invoke throws (one invoke-phase action per tx)", () => {
    const { transfers } = testEnv;
    const builder = transfers.alice
      .build()
      .invoke(() => ({ contractAddress: "0x1", calldata: [1n] }));

    expect(() =>
      builder.computeAndInvoke(() => ({ contractAddress: "0x2", computeData: [], invokeData: [] }))
    ).toThrow(
      "At most one invoke-phase action (.invoke() / .computeAndInvoke()) per transaction; already set."
    );
  });

  it("two computeAndInvoke on the builder throws", () => {
    const { transfers } = testEnv;
    const builder = transfers.alice
      .build()
      .computeAndInvoke(() => ({ contractAddress: "0x1", computeData: [], invokeData: [] }));

    expect(() =>
      builder.computeAndInvoke(() => ({ contractAddress: "0x2", computeData: [], invokeData: [] }))
    ).toThrow(
      "At most one invoke-phase action (.invoke() / .computeAndInvoke()) per transaction; already set."
    );
  });
});
