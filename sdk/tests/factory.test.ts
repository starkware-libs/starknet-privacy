import { describe, expect, it, vi, afterEach } from "vitest";
import { constants, type Account, type SignerInterface } from "starknet";
import { createPrivateTransfers } from "../src/factory.js";
import type { ProofProviderConfig, DiscoveryProviderConfig } from "../src/interfaces.js";
import { Mocknet } from "../src/testing/mocknet.js";
import { MockProofProvider } from "../src/testing/mock-proof-provider.js";
import { MockProofInvocationFactory } from "../src/testing/mock-proof-invocation-factory.js";
import { ContractDiscoveryProvider } from "../src/internal/contract-discovery.js";

const DISCOVERY_URL = "https://indexer.test";
const PROVER_URL = "https://prover.test";
const POOL_ADDRESS = 0x1n;

/** Minimal account for tests; MockProofInvocationFactory does not use signer for signing. */
function mockAccount(address: string): Account {
  return { address, signer: {} } as Account;
}

describe("createPrivateTransfers", () => {
  describe("with instance providers", () => {
    it("accepts a minimal user without requiring an Account", async () => {
      const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
      const env = mocknet.initialize();
      const pool = mocknet.pool;

      const transfers = createPrivateTransfers({
        user: {
          address: `0x${env.alice.address.toString(16)}`,
          signer: {} as SignerInterface,
        },
        viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
        provingProvider: new MockProofProvider(pool),
        discoveryProvider: new ContractDiscoveryProvider(pool),
        proofInvocationFactory: new MockProofInvocationFactory(),
        poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
      });

      mocknet.executeOutside(await transfers.build().register().execute());
      const { notes } = await transfers.discoverNotes();
      expect(notes).toBeDefined();
    });

    it("accepts ProofProviderInterface and DiscoveryProviderInterface and returns working PrivateTransfers", async () => {
      const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
      const env = mocknet.initialize();
      const pool = mocknet.pool;

      const transfers = createPrivateTransfers({
        account: mockAccount(`0x${env.alice.address.toString(16)}`),
        viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
        provingProvider: new MockProofProvider(pool),
        discoveryProvider: new ContractDiscoveryProvider(pool),
        proofInvocationFactory: new MockProofInvocationFactory(),
        poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
      });

      expect(transfers.user).toBeDefined();
      expect(transfers.build).toBeDefined();
      expect(transfers.discoverNotes).toBeDefined();
      expect(transfers.discoverChannels).toBeDefined();
      expect(transfers.discoverRequirement).toBeDefined();
      expect(transfers.execute).toBeDefined();

      mocknet.executeOutside(await transfers.build().register().execute());
      const { notes } = await transfers.discoverNotes();
      expect(notes).toBeDefined();
    });
  });

  describe("with config providers", () => {
    it("accepts ProofProviderConfig and DiscoveryProviderConfig and returns PrivateTransfersInterface", () => {
      const provingConfig: ProofProviderConfig = {
        url: PROVER_URL,
        chainId: constants.StarknetChainId.SN_SEPOLIA,
      };
      const discoveryConfig: DiscoveryProviderConfig = { url: DISCOVERY_URL };

      const transfers = createPrivateTransfers({
        account: mockAccount("0xabc"),
        viewingKeyProvider: { getViewingKey: async () => 0n },
        provingProvider: provingConfig,
        discoveryProvider: discoveryConfig,
        poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
      });

      expect(transfers.user).toBeDefined();
      expect(transfers.build).toBeDefined();
      expect(transfers.discoverNotes).toBeDefined();
      expect(transfers.discoverChannels).toBeDefined();
      expect(transfers.discoverRequirement).toBeDefined();
      expect(transfers.execute).toBeDefined();
    });

    it("with DiscoveryProviderConfig, discoverNotes uses IndexerDiscoveryProvider (calls config URL)", async () => {
      const originalFetch = globalThis.fetch;
      afterEach(() => {
        globalThis.fetch = originalFetch;
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            block_ref: "0x1",
            channels: [],
            subchannels: [],
            notes: [],
            cursor: { channel_discovery_complete: true, channels: {} },
          }),
        text: () => Promise.resolve("{}"),
      });
      globalThis.fetch = mockFetch;

      const transfers = createPrivateTransfers({
        account: mockAccount("0xabc"),
        viewingKeyProvider: { getViewingKey: async () => 0n },
        provingProvider: {
          url: PROVER_URL,
          chainId: constants.StarknetChainId.SN_SEPOLIA,
        },
        discoveryProvider: { url: DISCOVERY_URL },
        poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
      });

      await transfers.discoverNotes();

      expect(mockFetch).toHaveBeenCalled();
      const callUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(callUrl).toContain(DISCOVERY_URL);
    });
  });

  describe("with mixed config and instance", () => {
    it("accepts ProofProviderConfig + DiscoveryProviderInterface", () => {
      const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
      const env = mocknet.initialize();

      const transfers = createPrivateTransfers({
        account: mockAccount(`0x${env.alice.address.toString(16)}`),
        viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
        provingProvider: {
          url: PROVER_URL,
          chainId: constants.StarknetChainId.SN_SEPOLIA,
        },
        discoveryProvider: new ContractDiscoveryProvider(mocknet.pool),
        poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
      });

      expect(transfers.build).toBeDefined();
      expect(transfers.discoverNotes).toBeDefined();
    });

    it("accepts ProofProviderInterface + DiscoveryProviderConfig", async () => {
      const originalFetch = globalThis.fetch;
      afterEach(() => {
        globalThis.fetch = originalFetch;
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            block_ref: "0x1",
            channels: [],
            subchannels: [],
            notes: [],
            cursor: { channel_discovery_complete: true, channels: {} },
          }),
        text: () => Promise.resolve("{}"),
      });
      globalThis.fetch = mockFetch;

      const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
      const env = mocknet.initialize();

      const transfers = createPrivateTransfers({
        account: mockAccount(`0x${env.alice.address.toString(16)}`),
        viewingKeyProvider: { getViewingKey: async () => env.alice.privateKey },
        provingProvider: new MockProofProvider(mocknet.pool),
        discoveryProvider: { url: DISCOVERY_URL },
        proofInvocationFactory: new MockProofInvocationFactory(),
        poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
      });

      const { notes } = await transfers.discoverNotes();
      expect(notes).toBeDefined();
      expect(mockFetch).toHaveBeenCalled();
      const callUrl = (mockFetch.mock.calls[0] as unknown[])[0] as string;
      expect(callUrl).toContain(DISCOVERY_URL);
    });
  });

  describe("config resolution", () => {
    it("ProofProviderConfig with optional fields is passed to ProvingServiceProofProvider", () => {
      const transfers = createPrivateTransfers({
        account: mockAccount("0x1"),
        viewingKeyProvider: { getViewingKey: async () => 0n },
        provingProvider: {
          url: PROVER_URL,
          chainId: constants.StarknetChainId.SN_MAIN,
          requestTimeoutMs: 5000,
          blockIdentifier: "latest",
        },
        discoveryProvider: { url: DISCOVERY_URL },
        poolContractAddress: `0x${POOL_ADDRESS.toString(16)}`,
      });

      expect(transfers).toBeDefined();
      expect(transfers.build().execute).toBeDefined();
    });
  });
});
