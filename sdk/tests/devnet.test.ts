/**
 * Devnet integration tests
 *
 * These tests instantiate a local Starknet devnet, deploy contracts,
 * and test real interactions with the privacy pool.
 */

import { describe, it, beforeAll, beforeEach, afterAll, expect } from "vitest";
import { Devnet, createDevnetTestEnv, type DevnetTestEnv } from "../src/testing/index.js";
import { debugLog } from "../src/utils/logging.js";

describe("Devnet Integration", () => {
  let devnet: Devnet;
  let testEnv: DevnetTestEnv;
  let setupError: Error | undefined;

  beforeAll(async () => {
    try {
      devnet = new Devnet();
      testEnv = await createDevnetTestEnv(devnet);
    } catch (e) {
      setupError = e instanceof Error ? e : new Error(String(e));
    }
  }, 120000); // 120 second timeout for devnet startup and deployment

  // Workaround: vitest silently skips tests when beforeAll throws instead of
  // failing them (https://github.com/vitest-dev/vitest/issues/4820).
  // Re-throw in beforeEach so each test reports an explicit failure.
  beforeEach(() => {
    if (setupError) {
      throw new Error(`beforeAll failed: ${setupError.message}`);
    }
  });

  afterAll(async () => {
    await devnet?.cleanup();
  });

  it("should setup devnet with alice, bob, tokens, and privacy contract", async () => {
    const { env } = testEnv;

    // Verify Alice account
    expect(env.alice.address).toBeDefined();
    expect(env.alice.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Alice address:", env.alice.address);

    // Verify Bob account
    expect(env.bob.address).toBeDefined();
    expect(env.bob.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Bob address:", env.bob.address);

    // Verify token addresses
    expect(env.eth).toBeDefined();
    expect(env.strk).toBeDefined();
    console.log("ETH token:", env.eth);
    console.log("STRK token:", env.strk);

    // Verify privacy contract
    expect(env.privacy.address).toBeDefined();
    expect(env.privacy.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Privacy contract:", env.privacy.address);
  });

  it("should deposit 100 STRK to alice", async () => {
    const { env, transfers } = testEnv;

    // Approve the privacy pool to spend STRK tokens
    await env.alice.execute({
      contractAddress: env.strk,
      entrypoint: "approve",
      calldata: [env.privacy.address, 100n, 0n], // spender, amount_low, amount_high (u256)
    });

    const { callAndProof: bobCallAndProof } = await transfers.bob.build().register().execute();
    const bobReceipt = await devnet.executeOutside(bobCallAndProof);
    console.log("Bob register status:", bobReceipt.execution_status);
    if (bobReceipt.isReverted()) {
      console.error("Bob register REVERTED:", bobReceipt.revert_reason);
    }
    expect(bobReceipt.isReverted()).toBe(false);

    const { callAndProof } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(env.strk)
      .deposit({ amount: 100n })
      .transfer({ recipient: env.bob.address, amount: 50n })
      .surplusTo(env.alice.address)
      .execute();

    console.log("Alice deposit+transfer calldata length:", callAndProof.call.calldata.length);

    const receipt = await devnet.executeOutside(callAndProof);
    console.log("Alice deposit status:", receipt.execution_status);
    if (receipt.isReverted()) {
      console.error("Alice deposit REVERTED:", receipt.revert_reason);
    }
    expect(receipt.isReverted()).toBe(false);

    const notes = await transfers.alice.discoverNotes();
    debugLog("test", "should deposit", "notes", notes);

    expect(notes.notes.get(env.strk)?.length).toBe(1);
    expect(notes.notes.get(env.strk)?.[0].amount).toBe(50n);

    const { channels } = await transfers.alice.discoverChannels([env.bob.address]);
    debugLog("test", "should deposit", "channels", channels);

    expect(channels!.get(env.bob.address)?.tokens.get(env.strk)?.noteNonce).toBe(1);
  });
});
