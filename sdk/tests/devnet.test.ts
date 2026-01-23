/**
 * Devnet integration tests
 *
 * These tests instantiate a local Starknet devnet, deploy contracts,
 * and test real interactions with the privacy pool.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { DevnetEnvironment } from "../src/testing/index.js";
import { Devnet } from "../src/testing/devnet.js";

describe("Devnet Integration", () => {
  let devnet: Devnet;
  let setup: DevnetEnvironment;

  beforeAll(async () => {
    devnet = new Devnet();
    setup = await devnet.initialize();
  }, 120000); // 120 second timeout for devnet startup and deployment

  afterAll(() => {
    devnet.cleanup();
  });

  it("should setup devnet with alice, bob, tokens, and privacy contract", async () => {
    // Verify Alice account
    expect(setup.alice.address).toBeDefined();
    expect(setup.alice.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Alice address:", setup.alice.address);

    // Verify Bob account
    expect(setup.bob.address).toBeDefined();
    expect(setup.bob.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Bob address:", setup.bob.address);

    // Verify token addresses
    expect(setup.eth).toBeDefined();
    expect(setup.strk).toBeDefined();
    console.log("ETH token:", setup.eth);
    console.log("STRK token:", setup.strk);

    // Verify privacy contract
    expect(setup.privacy.address).toBeDefined();
    expect(setup.privacy.address).toMatch(/^0x[0-9a-f]+$/i);
    console.log("Privacy contract:", setup.privacy.address);
  });
});
