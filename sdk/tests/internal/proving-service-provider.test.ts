import { describe, it, expect, vi, afterEach } from "vitest";
import { constants, RpcProvider } from "starknet";
import { ProvingServiceProofProvider } from "../../src/internal/proving-service-provider.js";
import { PoolCapabilityError } from "../../src/internal/errors.js";

// Mock ohttp-ts and hpke so OhttpClient can be instantiated without real crypto.
vi.mock("ohttp-ts", () => ({
  OHTTPClient: vi.fn(),
  KeyConfig: { parseMultiple: vi.fn().mockReturnValue([{}]) },
}));
vi.mock("hpke", () => ({
  CipherSuite: vi.fn(),
  KEM_DHKEM_X25519_HKDF_SHA256: 0x20,
  KDF_HKDF_SHA256: 0x01,
  AEAD_AES_128_GCM: 0x01,
}));

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

describe("ProvingServiceProofProvider.resolvePoolCapability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects screening and caches it — calls the node only once", async () => {
    const callContract = vi.spyOn(RpcProvider.prototype, "callContract").mockResolvedValue(["0x1"]);

    const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
      nodeUrl: NODE_URL,
      poolAddress: POOL_ADDRESS,
    });

    expect(await provider.resolvePoolCapability()).toBe("screening");
    expect(await provider.resolvePoolCapability()).toBe("screening");
    expect(callContract).toHaveBeenCalledTimes(1);
  });

  it("detects compatibility when the view is absent (entrypoint-not-found)", async () => {
    vi.spyOn(RpcProvider.prototype, "callContract").mockRejectedValue(
      new Error("Entry point screening_version not found in contract")
    );

    const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
      nodeUrl: NODE_URL,
      poolAddress: POOL_ADDRESS,
    });

    expect(await provider.resolvePoolCapability()).toBe("compatibility");
  });

  it("re-detects after invalidatePoolCapabilityCache", async () => {
    const callContract = vi.spyOn(RpcProvider.prototype, "callContract").mockResolvedValue(["0x1"]);

    const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
      nodeUrl: NODE_URL,
      poolAddress: POOL_ADDRESS,
    });

    await provider.resolvePoolCapability();
    provider.invalidatePoolCapabilityCache();
    await provider.resolvePoolCapability();

    expect(callContract).toHaveBeenCalledTimes(2);
  });

  it("propagates a transient RPC failure as PoolCapabilityError (no silent compat)", async () => {
    vi.spyOn(RpcProvider.prototype, "callContract").mockRejectedValue(
      new Error("fetch failed: ECONNREFUSED")
    );

    const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
      nodeUrl: NODE_URL,
      poolAddress: POOL_ADDRESS,
    });

    await expect(provider.resolvePoolCapability()).rejects.toBeInstanceOf(PoolCapabilityError);
  });

  it("defaults to compatibility and warns when no nodeUrl is configured", async () => {
    const callContract = vi.spyOn(RpcProvider.prototype, "callContract");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const provider = new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID);

    expect(await provider.resolvePoolCapability()).toBe("compatibility");
    expect(callContract).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("ProvingServiceProofProvider with ohttp option", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs without error when ohttp is true", () => {
    expect(
      () => new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, { ohttp: true })
    ).not.toThrow();
  });

  it("constructs without error when ohttp has relayUrl and publicKeyConfig", () => {
    expect(
      () =>
        new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
          ohttp: {
            relayUrl: "https://relay.example.com",
            publicKeyConfig: new Uint8Array([1, 2, 3]),
          },
        })
    ).not.toThrow();
  });

  it("constructs without error when ohttp is combined with other options", () => {
    expect(
      () =>
        new ProvingServiceProofProvider(PROVER_URL, CHAIN_ID, {
          ohttp: true,
          nodeUrl: NODE_URL,
          poolAddress: POOL_ADDRESS,
          requestTimeoutMs: 60_000,
        })
    ).not.toThrow();
  });
});
