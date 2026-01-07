import { describe, expect, it, beforeAll } from "vitest";
import { CallData, transaction, type Call, type Contract } from "starknet";
import { SimulatedProofProvider } from "../../src/proof_providers/simulated.js";
import { getTestContext, deployEchoContract, type TestContext } from "../setup.js";

describe("SimulatedProofProvider", () => {
  let ctx: TestContext;
  let echoContract: Contract;

  beforeAll(async () => {
    ctx = getTestContext();
    echoContract = await deployEchoContract(ctx);
  });

  /**
   * Build an invocation for a set of calls.
   * Since we use skipValidate=true in simulation, we don't need to sign
   * or use the correct nonce.
   */
  function buildInvocation(calls: Call[]) {
    // Build calldata for the account's __execute__ (Cairo 1 format)
    const calldata = transaction.getExecuteCalldata(calls, "1");

    return {
      contractAddress: ctx.account.address,
      calldata,
      signature: [], // Empty signature - validation is skipped
    };
  }

  it("should simulate transaction and return execution result", async () => {
    const simulatedProvider = new SimulatedProofProvider({
      nodeUrl: ctx.nodeUrl,
    });

    // Build a call to the echo function
    const call: Call = {
      contractAddress: echoContract.address,
      entrypoint: "echo",
      calldata: CallData.compile({ a: 42n, b: 123n }),
    };

    // Build the invocation (no signature needed for simulation)
    const invocation = buildInvocation([call]);

    // Use SimulatedProofProvider to prove
    const proof = await simulatedProvider.prove(invocation);

    // Verify the proof contains the execution result
    expect(proof.output).toBeDefined();
    expect(proof.output.length).toBeGreaterThan(0);

    // The echo function returns (a, b) which should be in the result
    // The result format depends on the account's __execute__ return format
    // For OZ accounts, it returns the outputs of all calls
    expect(proof.output).toContain("0x2a"); // 42 in hex
    expect(proof.output).toContain("0x7b"); // 123 in hex
  });

  it("should throw on reverted transaction", async () => {
    const simulatedProvider = new SimulatedProofProvider({
      nodeUrl: ctx.nodeUrl,
    });

    // Build an invalid invocation (calling non-existent function)
    const invalidCall: Call = {
      contractAddress: echoContract.address,
      entrypoint: "non_existent_function",
      calldata: [],
    };

    // Build the invocation (no signature needed for simulation)
    const invocation = buildInvocation([invalidCall]);

    // Should throw because the transaction will revert
    await expect(simulatedProvider.prove(invocation)).rejects.toThrow();
  });
});
