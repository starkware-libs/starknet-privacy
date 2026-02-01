/**
 * Tests for parallel discovery - verifies ContractDiscoveryProvider makes
 * concurrent calls and doesn't duplicate calls.
 */

import { describe, it, expect } from "vitest";
// Import directly from specific modules to avoid loading devnet.js (Node-only)
import {
  ContractDiscoveryProvider,
  type IPoolContract,
} from "../../src/internal/contract-discovery.js";
import { createConcurrencyProfiler, formatReport } from "../../src/testing/concurrency-profiler.js";
import { Mocknet } from "../../src/testing/mocknet.js";
import { Channel } from "../../src/internal/channel.js";
import { derivePublicKey } from "../../src/utils/crypto.js";
import { compute_channel_key, compute_note_id, compute_nullifier } from "../../src/utils/hashes.js";

describe("Parallel Discovery", () => {
  it("should discover notes with parallelism (12 senders, 10 tokens, 16 notes each, half spent)", async () => {
    // Configuration: 12 senders × 10 tokens × 16 notes = 1,920 notes total, 960 spent
    const NUM_SENDERS = 12;
    const NUM_TOKENS = 10;
    const NUM_NOTES = 16;

    const mocknet = new Mocknet({ poolAddress: 0x1n, validateBalances: false });
    const env = mocknet.initialize();
    const pool = mocknet.pool;

    const aliceAddress = env.alice.address;
    const aliceKey = env.alice.privateKey;
    const alicePublicKey = derivePublicKey(aliceKey);

    // Generate tokens
    const tokens = Array.from({ length: NUM_TOKENS }, (_, i) => BigInt(0xace000 + i));

    // Register Alice (recipient)
    pool.setupChannel(aliceAddress, aliceKey, aliceAddress, new Channel(alicePublicKey));

    // Create senders
    const senders = Array.from({ length: NUM_SENDERS }, (_, i) => ({
      address: BigInt(0x2000 + i),
      key: BigInt(300000 + i),
    }));

    for (const sender of senders) {
      const senderPublicKey = derivePublicKey(sender.key);

      // Register sender
      pool.setupChannel(sender.address, sender.key, sender.address, new Channel(senderPublicKey));

      // Create channel from sender to Alice
      const channelKey = compute_channel_key(
        sender.address,
        sender.key,
        aliceAddress,
        BigInt(alicePublicKey)
      );
      const channel = new Channel(alicePublicKey);
      channel.key = channelKey;

      // Add all tokens (subchannels)
      for (let t = 0; t < NUM_TOKENS; t++) {
        channel.tokens.set(tokens[t], { tokenIndex: t, noteNonce: NUM_NOTES });
      }
      pool.setupChannel(sender.address, sender.key, aliceAddress, channel);

      // Create notes for each token
      for (let t = 0; t < NUM_TOKENS; t++) {
        for (let n = 0; n < NUM_NOTES; n++) {
          const noteId = compute_note_id(channelKey, tokens[t], n);
          pool.setupNote(
            aliceAddress,
            {
              id: noteId,
              amount: BigInt(100 + n),
              created: 0,
              witness: { channelKey, nonce: n, r: BigInt(6000 + t * 1000 + n) },
              sender: sender.address,
            },
            tokens[t]
          );

          // Mark half of the notes as spent (even indices)
          if (n % 2 === 0) {
            const nullifier = compute_nullifier(channelKey, tokens[t], n, aliceKey);
            (pool as unknown as { nullifiers: Set<bigint> }).nullifiers.add(nullifier);
          }
        }
      }
    }

    // Wrap pool with profiler
    const profiler = createConcurrencyProfiler(pool as unknown as IPoolContract, 5);
    const discovery = new ContractDiscoveryProvider(profiler.pool);

    // Discover notes for Alice
    await discovery.discoverNotes(aliceAddress, aliceKey);

    const report = profiler.getReport();
    console.log("\n" + formatReport(report));

    // Assert: no duplicate calls
    expect(report.duplicates, `Duplicate calls found: ${report.duplicates.join(", ")}`).toEqual([]);

    // Should have meaningful parallelism
    expect(report.maxConcurrent).toBeGreaterThan(1);
    expect(report.parallelismFactor).toBeGreaterThan(1);

    console.log(
      `\nExpected: ${NUM_SENDERS} senders × ${NUM_TOKENS} tokens × ${NUM_NOTES} notes = ${NUM_SENDERS * NUM_TOKENS * NUM_NOTES} notes (${(NUM_SENDERS * NUM_TOKENS * NUM_NOTES) / 2} spent)`
    );
  }, 60000);

  it("should discover channels with parallelism (12 recipients, 10 tokens, 16 notes each)", async () => {
    // Configuration: 12 recipients × 10 tokens × 16 notes = 1,920 notes total
    const NUM_RECIPIENTS = 12;
    const NUM_TOKENS = 10;
    const NUM_NOTES = 16;

    const mocknet = new Mocknet({ poolAddress: 0x2n, validateBalances: false });
    const env = mocknet.initialize();
    const pool = mocknet.pool;

    const aliceAddress = env.alice.address;
    const aliceKey = env.alice.privateKey;
    const alicePublicKey = derivePublicKey(aliceKey);

    // Generate tokens
    const tokens = Array.from({ length: NUM_TOKENS }, (_, i) => BigInt(0xbee000 + i));

    // Register Alice (sender)
    pool.setupChannel(aliceAddress, aliceKey, aliceAddress, new Channel(alicePublicKey));

    // Create recipients
    const recipients = Array.from({ length: NUM_RECIPIENTS }, (_, i) => ({
      address: BigInt(0x3000 + i),
      key: BigInt(400000 + i),
    }));

    for (const recipient of recipients) {
      const recipientPublicKey = derivePublicKey(recipient.key);

      // Register recipient
      pool.setupChannel(
        recipient.address,
        recipient.key,
        recipient.address,
        new Channel(recipientPublicKey)
      );

      // Create channel from Alice to recipient
      const channelKey = compute_channel_key(
        aliceAddress,
        aliceKey,
        recipient.address,
        BigInt(recipientPublicKey)
      );
      const channel = new Channel(recipientPublicKey);
      channel.key = channelKey;

      // Add all tokens (subchannels)
      for (let t = 0; t < NUM_TOKENS; t++) {
        channel.tokens.set(tokens[t], { tokenIndex: t, noteNonce: NUM_NOTES });
      }
      pool.setupChannel(aliceAddress, aliceKey, recipient.address, channel);

      // Create notes for each token
      for (let t = 0; t < NUM_TOKENS; t++) {
        for (let n = 0; n < NUM_NOTES; n++) {
          pool.setupNote(
            recipient.address,
            {
              id: compute_note_id(channelKey, tokens[t], n),
              amount: BigInt(200 + n),
              created: 0,
              witness: { channelKey, nonce: n, r: BigInt(7000 + t * 1000 + n) },
              sender: aliceAddress,
            },
            tokens[t]
          );
        }
      }
    }

    // Wrap pool with profiler
    const profiler = createConcurrencyProfiler(pool as unknown as IPoolContract, 5);
    const discovery = new ContractDiscoveryProvider(profiler.pool);

    // Discover channels for Alice (outgoing channels to all recipients)
    const recipientAddresses = recipients.map((r) => r.address);
    await discovery.discoverChannels(aliceAddress, aliceKey, recipientAddresses);

    const report = profiler.getReport();
    console.log("\n" + formatReport(report));

    // Assert: no duplicate calls
    expect(report.duplicates, `Duplicate calls found: ${report.duplicates.join(", ")}`).toEqual([]);

    // Should have meaningful parallelism
    expect(report.maxConcurrent).toBeGreaterThan(1);
    expect(report.parallelismFactor).toBeGreaterThan(1);

    console.log(
      `\nExpected: ${NUM_RECIPIENTS} recipients × ${NUM_TOKENS} tokens × ${NUM_NOTES} notes = ${NUM_RECIPIENTS * NUM_TOKENS * NUM_NOTES} notes`
    );
  }, 60000);
});
