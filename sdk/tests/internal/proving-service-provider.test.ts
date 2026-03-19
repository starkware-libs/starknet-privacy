import { describe, it, expect, vi, afterEach } from "vitest";
import { constants, RpcProvider } from "starknet";
import { ProvingServiceProofProvider } from "../../src/internal/proving-service-provider.js";

const PROVER_URL = "https://prover.test";
const NODE_URL = "https://node.test";
const POOL_ADDRESS = "0x1234";
const CHAIN_ID = constants.StarknetChainId.SN_SEPOLIA;

describe("ProvingServiceProofProvider.getDefaultDetails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("without nodeUrl", () => {
    it("returns fallback nonce 0n", async () => {
      const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID);
      const details = await provider.getDefaultDetails();
      expect(details.nonce).toBe(0n);
    });

    it("throws when nodeUrl is set but poolAddress is missing", () => {
      expect(
        () => new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, { nodeUrl: NODE_URL })
      ).toThrow("nodeUrl requires poolAddress");
    });
  });

  describe("with nodeUrl and poolAddress", () => {
    it("fetches nonce from chain on first call", async () => {
      const getNonce = vi
        .spyOn(RpcProvider.prototype, "getNonceForAddress")
        .mockResolvedValue("0x5");

      const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
        nodeUrl: NODE_URL,
        poolAddress: POOL_ADDRESS,
      });

      const details = await provider.getDefaultDetails();

      expect(details.nonce).toBe(5n);
      expect(getNonce).toHaveBeenCalledTimes(1);
      expect(getNonce).toHaveBeenCalledWith(POOL_ADDRESS, "latest");
    });

    it("uses cached nonce on subsequent calls — fetches only once", async () => {
      const getNonce = vi
        .spyOn(RpcProvider.prototype, "getNonceForAddress")
        .mockResolvedValue("0x5");

      const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
        nodeUrl: NODE_URL,
        poolAddress: POOL_ADDRESS,
      });

      await provider.getDefaultDetails();
      await provider.getDefaultDetails();
      await provider.getDefaultDetails();

      expect(getNonce).toHaveBeenCalledTimes(1);
    });

    it("returns same cached nonce across calls", async () => {
      vi.spyOn(RpcProvider.prototype, "getNonceForAddress").mockResolvedValue("0xa");

      const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
        nodeUrl: NODE_URL,
        poolAddress: POOL_ADDRESS,
      });

      const first = await provider.getDefaultDetails();
      const second = await provider.getDefaultDetails();

      expect(first.nonce).toBe(10n);
      expect(second.nonce).toBe(10n);
    });
  });

  describe("invalidateNonceCache", () => {
    it("forces a fresh fetch after invalidation", async () => {
      const getNonce = vi
        .spyOn(RpcProvider.prototype, "getNonceForAddress")
        .mockResolvedValueOnce("0x5")
        .mockResolvedValueOnce("0x6");

      const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
        nodeUrl: NODE_URL,
        poolAddress: POOL_ADDRESS,
      });

      const first = await provider.getDefaultDetails();
      expect(first.nonce).toBe(5n);

      provider.invalidateNonceCache();

      const second = await provider.getDefaultDetails();
      expect(second.nonce).toBe(6n);
      expect(getNonce).toHaveBeenCalledTimes(2);
    });

    it("does not fetch again after invalidation if getDefaultDetails is not called", async () => {
      const getNonce = vi
        .spyOn(RpcProvider.prototype, "getNonceForAddress")
        .mockResolvedValue("0x5");

      const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
        nodeUrl: NODE_URL,
        poolAddress: POOL_ADDRESS,
      });

      await provider.getDefaultDetails();
      provider.invalidateNonceCache();
      // no second getDefaultDetails call

      expect(getNonce).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when no nonce provider is configured", async () => {
      const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID);
      expect(() => provider.invalidateNonceCache()).not.toThrow();
      const details = await provider.getDefaultDetails();
      expect(details.nonce).toBe(0n);
    });
  });
});
