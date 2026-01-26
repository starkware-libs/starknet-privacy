/**
 * Devnet integration tests
 *
 * These tests instantiate a local Starknet devnet, deploy contracts,
 * and test real interactions with the privacy pool.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { ContractDiscoveryProvider, type DevnetEnvironment } from "../src/testing/index.js";
import { createPrivateTransfers } from "../src/factory.js";
import { CallMockProofProvider } from "../src/testing/mock-proving.js";
import { Devnet } from "../src/testing/devnet.js";
import { debugLog } from "../src/utils/logging.js";
import { PrivateTransfersInterface } from "../src/interfaces.js";
import { toBigInt } from "../src/utils/crypto.js";
import { constants } from "starknet";

describe("Devnet Integration", () => {
  let devnet: Devnet;
  let setup: DevnetEnvironment;
  const transfers: { [key: string]: PrivateTransfersInterface } = {};

  beforeAll(async () => {
    devnet = new Devnet();
    setup = await devnet.initialize();
    const chainId = constants.StarknetChainId.SN_SEPOLIA;
    transfers.alice = createPrivateTransfers({
      account: setup.alice,
      viewingKeyProvider: { getViewingKey: () => toBigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(setup.provider, chainId),
      discoveryProvider: new ContractDiscoveryProvider(setup.privacy),
      poolContractAddress: setup.privacy.address,
      poolAccount: setup.admin,
    });

    transfers.bob = createPrivateTransfers({
      account: setup.bob,
      viewingKeyProvider: { getViewingKey: () => toBigInt("0xB0B") },
      provingProvider: new CallMockProofProvider(setup.provider, chainId),
      discoveryProvider: new ContractDiscoveryProvider(setup.privacy),
      poolContractAddress: setup.privacy.address,
      poolAccount: setup.admin,
    });
  }, 120000); // 120 second timeout for devnet startup and deployment

  afterAll(async () => {
    await devnet.cleanup();
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

  it("should deposit 100 STRK to alice", async () => {
    // Approve the privacy pool to spend STRK tokens
    await setup.alice.execute({
      contractAddress: setup.strk,
      entrypoint: "approve",
      calldata: [setup.privacy.address, 100n, 0n], // spender, amount_low, amount_high (u256)
    });

    const { callAndProof: bobCallAndProof } = await transfers.bob.build().register().execute();
    await devnet.executeOutside(bobCallAndProof);

    const { callAndProof } = await transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(setup.strk)
      .deposit({ amount: 100n, recipient: setup.alice.address })
      .transfer({ recipient: setup.bob.address, amount: 50n })
      .execute();

    debugLog("test", "should deposit", "call", callAndProof.call);

    const receipt = await devnet.executeOutside(callAndProof);
    debugLog("test", "should deposit", receipt);

    const notes = await transfers.alice.discoverNotes();
    debugLog("test", "should deposit", "notes", notes);

    expect(notes.notes.get(setup.strk)?.length).toBe(1);
    expect(notes.notes.get(setup.strk)?.[0].amount).toBe(50n);

    const { channels } = await transfers.alice.discoverChannels([setup.bob.address]);
    debugLog("test", "should deposit", "channels", channels);

    expect(channels.get(setup.bob.address)?.tokens.get(setup.strk)?.noteNonce).toBe(1);
  });
});
