import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { constants } from "starknet";
import {
  Devnet,
  CallMockProofProvider,
  IndexerDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  createPrivateTransfers,
  SetupRequirement,
} from "@starkware-libs/starknet-privacy-sdk";
import { createE2eTestEnv, type E2eTestEnv } from "../../src/harness.js";

// Deterministic 32-byte X25519 private key for testing (hex-encoded).
const OHTTP_TEST_KEY =
  "0101010101010101010101010101010101010101010101010101010101010101";

describe("E2E OHTTP", () => {
  let devnet: Devnet;
  let env: E2eTestEnv;

  beforeAll(async () => {
    devnet = new Devnet();
    env = await createE2eTestEnv(devnet, {
      indexer: {
        env: {
          OHTTP_KEY: OHTTP_TEST_KEY,
          OHTTP_ENABLED: "true",
        },
      },
    });
  });

  afterAll(async () => {
    await env?.indexer.shutdown();
    await devnet?.cleanup();
  });

  it("deposit + transfer discoverable via OHTTP-encrypted channel", async () => {
    const { env: de } = env;

    // Approve STRK spending
    await de.alice.execute({
      contractAddress: de.strk,
      entrypoint: "approve",
      calldata: [de.privacy.address, 100n, 0n],
    });

    // Register bob
    const { callAndProof: bobReg } = await env.transfers.bob
      .build()
      .register()
      .execute();
    await devnet.executeOutside(bobReg);

    // Alice: deposit 100 STRK + transfer 50 to bob
    const { callAndProof } = await env.transfers.alice
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(de.strk)
      .deposit({ amount: 100n })
      .transfer({ recipient: de.bob.address, amount: 50n })
      .surplusTo(de.alice.address)
      .execute();

    await devnet.executeOutside(callAndProof);
    await env.indexer.waitForBlock(devnet.url);

    // Create OHTTP-enabled discovery provider
    const ohttpDiscovery = new IndexerDiscoveryProvider(
      env.indexer.apiUrl,
      de.privacy.address,
      { ohttp: true },
    );

    const aliceOhttp = createPrivateTransfers({
      account: de.alice,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(
        de.provider,
        constants.StarknetChainId.SN_SEPOLIA,
      ),
      discoveryProvider: ohttpDiscovery,
      poolContractAddress: de.privacy.address,
      // Source-built devnet pool — unpinned class hash; force compatibility calldata.
      poolMode: "compatibility",
    });

    // Discover notes via OHTTP — if this works, the full encrypt/decrypt pipeline is correct
    const { notes } = await aliceOhttp.discoverNotes();
    expect(notes.size).toBeGreaterThanOrEqual(1);
    const strkNotes = notes.get(BigInt(de.strk));
    expect(strkNotes).toBeDefined();
    expect(strkNotes!.length).toBeGreaterThanOrEqual(1);
    expect(strkNotes![0].amount).toBe(50n);

    // Discover channels via OHTTP
    const { channels } = await aliceOhttp.discoverChannels([
      de.alice.address,
      de.bob.address,
    ]);
    expect(channels).toBeDefined();
    expect(channels!.size).toBeGreaterThanOrEqual(2);
    expect(channels!.has(BigInt(de.alice.address))).toBe(true);
    expect(channels!.has(BigInt(de.bob.address))).toBe(true);

    // Preflight check via OHTTP
    const req = await aliceOhttp.discoverRequirement(de.bob.address, de.strk);
    expect(req).toBe(SetupRequirement.Ready);

    // Bob's discovery via OHTTP
    const bobOhttp = createPrivateTransfers({
      account: de.bob,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xB0B") },
      provingProvider: new CallMockProofProvider(
        de.provider,
        constants.StarknetChainId.SN_SEPOLIA,
      ),
      discoveryProvider: ohttpDiscovery,
      poolContractAddress: de.privacy.address,
      // Source-built devnet pool — unpinned class hash; force compatibility calldata.
      poolMode: "compatibility",
    });

    const { notes: bobNotes } = await bobOhttp.discoverNotes();
    expect(bobNotes.size).toBeGreaterThanOrEqual(1);
    const bobStrkNotes = bobNotes.get(BigInt(de.strk));
    expect(bobStrkNotes).toBeDefined();
    expect(bobStrkNotes!.length).toBe(1);
    expect(bobStrkNotes![0].amount).toBe(50n);
  });
});
