/**
 * Tests for PrivacyPool snapshot/restore functionality.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PrivacyPool, type StateCallback } from "../../src/testing/pool.js";
import { ERC20s } from "../../src/testing/erc20.js";
import { toBigInt } from "../../src/utils/crypto.js";
import type { ClientAction } from "../../src/client-actions.js";

const POOL_ADDRESS = "0x1000";
const ALICE = "0x1";
const BOB = "0x2";
const ALICE_KEY = 12345n;
const BOB_KEY = 67890n;
const STRK = "0x534b52";

describe("PrivacyPool snapshot/restore", () => {
  let erc20s: ERC20s;
  let pool: PrivacyPool;

  /** Execute and apply the callbacks */
  const exec = (sender: string, actions: ClientAction[]): StateCallback[] => {
    const cbs = pool.execute(sender, actions);
    for (const cb of cbs) cb();
    return cbs;
  };

  beforeEach(() => {
    erc20s = new ERC20s();
    pool = new PrivacyPool(POOL_ADDRESS, erc20s);
    erc20s.get(STRK).setBalance(ALICE, 1000n);
  });

  it("restores registrations, channels, and ERC20 balances through multiple snapshot cycles", () => {
    // === Snapshot 1: Empty pool ===
    const snap1 = pool.snapshot();

    // Register Alice
    exec(ALICE, [{ type: "SetViewingKey", input: { privateKey: ALICE_KEY, random: 1n } }]);
    expect(pool.isRegistered(ALICE)).toBe(true);

    // === Snapshot 2: Alice registered ===
    const snap2 = pool.snapshot();

    // Register Bob
    exec(BOB, [{ type: "SetViewingKey", input: { privateKey: BOB_KEY, random: 2n } }]);
    expect(pool.isRegistered(BOB)).toBe(true);

    // Open channel Alice → Bob
    const bobPubKey = toBigInt(pool.getPublicKey(BOB));
    exec(ALICE, [
      {
        type: "OpenChannel",
        input: {
          senderPrivateKey: ALICE_KEY,
          recipientAddr: BOB,
          recipientPublicKey: bobPubKey,
          random: 3n,
        },
      },
    ]);
    expect(pool.getChannels(BOB).length).toBe(1);

    // === Snapshot 3: Both registered, channel open ===
    const snap3 = pool.snapshot();

    // Deposit (balanced with withdraw)
    exec(ALICE, [
      { type: "Deposit", input: { token: STRK, amount: 100n } },
      { type: "Withdraw", input: { token: STRK, amount: 100n, withdrawalTarget: ALICE } },
    ]);
    // Balances unchanged due to immediate withdraw, but let's modify directly
    erc20s.get(STRK).setBalance(ALICE, 500n);
    expect(erc20s.get(STRK).balanceOf(ALICE)).toBe(500n);

    // === Test restore to snap3: channel still exists, balance restored ===
    pool.restore(snap3);
    expect(pool.isRegistered(ALICE)).toBe(true);
    expect(pool.isRegistered(BOB)).toBe(true);
    expect(pool.getChannels(BOB).length).toBe(1);
    expect(erc20s.get(STRK).balanceOf(ALICE)).toBe(1000n);

    // === Test restore to snap2: Bob unregistered, no channel ===
    pool.restore(snap2);
    expect(pool.isRegistered(ALICE)).toBe(true);
    expect(pool.isRegistered(BOB)).toBe(false);

    // === Test restore to snap1: completely empty ===
    pool.restore(snap1);
    expect(pool.isRegistered(ALICE)).toBe(false);

    // Can re-register and re-execute all actions
    exec(ALICE, [{ type: "SetViewingKey", input: { privateKey: ALICE_KEY, random: 1n } }]);
    exec(BOB, [{ type: "SetViewingKey", input: { privateKey: BOB_KEY, random: 2n } }]);
    exec(ALICE, [
      {
        type: "OpenChannel",
        input: {
          senderPrivateKey: ALICE_KEY,
          recipientAddr: BOB,
          recipientPublicKey: bobPubKey,
          random: 3n,
        },
      },
    ]);
    expect(pool.getChannels(BOB).length).toBe(1);
  });
});
