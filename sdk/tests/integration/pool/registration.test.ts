import { describe, expect, it, beforeAll } from "vitest";
import { Pool } from "../../../src/pool.js";
import { SimulatedProofProvider } from "../../../src/proof_providers/simulated.js";
import { getTestContext, deployPrivacyContract, type TestContext } from "../../setup.js";
import { DEVNET_TX_OPTIONS } from "../../globalSetup.js";

describe("Pool Registration", () => {
  let ctx: TestContext;
  let privacyContractAddress: string;

  // Test viewing key - using format similar to Cairo tests
  // 'PRIVATE_KEY' + 1 = 0x505249564154455f4b455a
  const testViewingKey = 0x505249564154455f4b455an;

  beforeAll(async () => {
    ctx = getTestContext();
    privacyContractAddress = await deployPrivacyContract(ctx);
  });

  it("should return false for isRegistered when user is not registered", async () => {
    const proofProvider = new SimulatedProofProvider({
      nodeUrl: ctx.nodeUrl,
    });

    const pool = new Pool(
      {
        account: ctx.account,
        viewingSigner: testViewingKey,
        provingProvider: proofProvider,
        pool: privacyContractAddress,
      },
      ctx.privacyAbi
    );

    const isRegistered = await pool.isRegistered();
    expect(isRegistered).toBe(false);
  });

  it("should return CallAndProof from register()", async () => {
    const proofProvider = new SimulatedProofProvider({
      nodeUrl: ctx.nodeUrl,
    });

    const pool = new Pool(
      {
        account: ctx.account,
        viewingSigner: testViewingKey,
        provingProvider: proofProvider,
        pool: privacyContractAddress,
      },
      ctx.privacyAbi
    );

    // Use a fixed random value for testing
    const random = 12345n;
    const result = await pool.register(random);

    // Verify the result structure
    expect(result.call).toBeDefined();
    expect(result.call.contractAddress).toBe(privacyContractAddress);
    expect(result.call.entrypoint).toBe("execute_actions");
    expect(result.call.calldata).toBeDefined();

    expect(result.proof).toBeDefined();
    expect(result.proof.output).toBeDefined();
    expect(result.proof.output.length).toBeGreaterThan(0);
  });

  it("should register user and isRegistered should return true", { timeout: 30000 }, async () => {
    const proofProvider = new SimulatedProofProvider({
      nodeUrl: ctx.nodeUrl,
    });

    const pool = new Pool(
      {
        account: ctx.account,
        viewingSigner: testViewingKey,
        provingProvider: proofProvider,
        pool: privacyContractAddress,
      },
      ctx.privacyAbi
    );

    // Use a fixed random value for testing
    const random = 12345n;
    const registerResult = await pool.register(random);

    // Execute the registration on-chain
    const executeResponse = await ctx.account.execute(registerResult.call, { tip: 1000n });
    await ctx.provider.waitForTransaction(executeResponse.transaction_hash, DEVNET_TX_OPTIONS);

    // Verify user is now registered
    const isRegistered = await pool.isRegistered();
    expect(isRegistered).toBe(true);
  });

  it("should throw error when random is zero", async () => {
    const proofProvider = new SimulatedProofProvider({
      nodeUrl: ctx.nodeUrl,
    });

    const pool = new Pool(
      {
        account: ctx.account,
        viewingSigner: testViewingKey,
        provingProvider: proofProvider,
        pool: privacyContractAddress,
      },
      ctx.privacyAbi
    );

    await expect(pool.register(0n)).rejects.toThrow("Random value must be non-zero");
  });
});
