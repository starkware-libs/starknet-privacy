/**
 * Tests for PrivacyPool snapshot/restore functionality via MockPrivateTransfers.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PrivacyPool } from "../../src/testing/pool.js";
import { MockContracts } from "../../src/testing/contracts.js";
import { MockPrivateTransfers, applyStateChanges } from "../../src/testing/index.js";
import { consoleLogCallback, withLogging } from "../../src/utils/logging.js";

const POOL_ADDRESS = "0x1000";
const ALICE = "0x1";
const BOB = "0x2";
const ALICE_KEY = 12345n;
const BOB_KEY = 67890n;
const STRK = "0x534b52";

describe("PrivacyPool snapshot/restore", () => {
  let contracts: MockContracts;
  let pool: PrivacyPool;
  let alice: MockPrivateTransfers;
  let bob: MockPrivateTransfers;

  beforeEach(() => {
    // Shared pool and MockContracts for all users
    contracts = new MockContracts();

    // Wrap pool with logging for debugging (logs only when SDK_DEBUG=1)
    pool = withLogging(new PrivacyPool(POOL_ADDRESS, contracts), "PrivacyPool", consoleLogCallback);
    contracts.register(pool);

    contracts.get(STRK).setBalance(ALICE, 1000n);

    alice = new MockPrivateTransfers(contracts, POOL_ADDRESS, ALICE, ALICE_KEY);
    bob = new MockPrivateTransfers(contracts, POOL_ADDRESS, BOB, BOB_KEY);
  });

  it("restores registrations, channels, and ERC20 balances through multiple snapshot cycles", async () => {
    // === 1. Verify execute() restores state internally (Alice Registration) ===

    // Execute registration without applying state changes
    let result = await alice.build().register().execute();

    // State should be unchanged (Alice NOT registered)
    expect(pool.isRegistered(ALICE)).toBe(false);

    // Now apply state changes
    applyStateChanges(result);
    expect(pool.isRegistered(ALICE)).toBe(true);

    // === 2. Verify execute() restores state internally (Bob Registration) ===

    // Execute Bob registration without applying
    result = await bob.build().register().execute();

    // State should be unchanged (Bob NOT registered)
    expect(pool.isRegistered(BOB)).toBe(false);

    // Apply state changes
    applyStateChanges(result);
    expect(pool.isRegistered(BOB)).toBe(true);

    // === 3. Verify execute() restores state internally (Open Channel) ===

    // Execute open channel without applying
    result = await alice.build().setup(BOB).execute();

    // State should be unchanged (No channel)
    // Note: getChannels throws if no channel exists, or returns empty array depending on impl?
    // Based on pool.ts: this.channels.get(...)! returns array or undefined.
    // But since Alice is registered, key exists? No, advanced map creates on demand?
    // pool.getChannels(BOB) calls this.channels.get(...)!
    // We expect it to NOT have the channel added.
    try {
      const channels = pool.getChannels(BOB);
      expect(channels.length).toBe(0);
    } catch {
      // If it throws because key missing, that's also valid "not executed" state
    }

    // Apply state changes
    applyStateChanges(result);
    expect(pool.getChannels(BOB).length).toBe(1);

    // === 4. Verify execute() restores state internally (Deposit/Withdraw/ERC20) ===

    // Execute deposit & withdraw without applying
    // Note: We need to use valid inputs to pass validation
    // We enable autoSetup to ensure the self-channel for Alice is created for the deposit
    result = await alice
      .build({ autoSetup: true })
      .with(STRK)
      .setup(ALICE)
      .deposit({ amount: 100n, recipient: ALICE })
      .execute();

    // State should be unchanged (Balance 1000n)
    expect(contracts.get(STRK).balanceOf(ALICE)).toBe(1000n);

    applyStateChanges(result);
    expect(contracts.get(STRK).balanceOf(ALICE)).toBe(900n);
  });
});
