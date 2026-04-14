import { describe, it, expect, vi, afterEach } from "vitest";
import { ProvingService, type MessageToL1 } from "../../src/internal/proving-service.js";
import type { OhttpClient } from "../../src/internal/ohttp-client.js";

const PROVER_URL = "https://prover.test";

/** Minimal INVOKE v3 transaction for request tests. */
const MINIMAL_INVOKE_TX = {
  type: "INVOKE" as const,
  sender_address: "0x1",
  calldata: [] as string[],
  version: "0x3" as const,
  signature: [] as string[],
  nonce: "0x0",
  resource_bounds: {
    l1_gas: { max_amount: "0x1", max_price_per_unit: "0x1" },
    l2_gas: { max_amount: "0x1", max_price_per_unit: "0x1" },
    l1_data_gas: { max_amount: "0x1", max_price_per_unit: "0x1" },
  },
  tip: "0x0",
  paymaster_data: [] as string[],
  account_deployment_data: [] as string[],
  nonce_data_availability_mode: "L2" as const,
  fee_data_availability_mode: "L2" as const,
};

const DEFAULT_PROVE_RESULT = {
  proof: "YQ==",
  proof_facts: [] as string[],
  l2_to_l1_messages: [] as Array<{ from_address: string; to_address: string; payload: string[] }>,
};

function mockOhttpClient(returnValue: unknown): OhttpClient {
  return {
    post: vi.fn().mockResolvedValue(returnValue),
  } as unknown as OhttpClient;
}

describe("ProvingService with OHTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes requests through ohttpClient when configured", async () => {
    const ohttpClient = mockOhttpClient({ jsonrpc: "2.0", id: 1, result: "0.10.0" });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });
    const result = await service.getSpecVersion();

    expect(result).toBe("0.10.0");
    expect(ohttpClient.post).toHaveBeenCalledOnce();
    const [path, body] = (ohttpClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe("");
    expect(body).toMatchObject({ method: "starknet_specVersion", params: [] });
  });

  it("does not call fetch when ohttpClient is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ohttpClient = mockOhttpClient({ jsonrpc: "2.0", id: 1, result: "0.10.0" });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });
    await service.getSpecVersion();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles JSON-RPC errors through OHTTP path", async () => {
    const ohttpClient = mockOhttpClient({
      jsonrpc: "2.0",
      id: 1,
      error: { code: 24, message: "Block not found" },
    });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });

    await expect(service.proveTransaction("latest", MINIMAL_INVOKE_TX)).rejects.toThrow(
      /Proving service error \(code 24\)/
    );
  });

  it("throws when OHTTP response has no result", async () => {
    const ohttpClient = mockOhttpClient({ jsonrpc: "2.0", id: 1 });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });

    await expect(service.proveTransaction("latest", MINIMAL_INVOKE_TX)).rejects.toThrow(
      /Proving service returned no result/
    );
  });

  it("validates proveTransaction result schema through OHTTP path", async () => {
    const ohttpClient = mockOhttpClient({
      jsonrpc: "2.0",
      id: 1,
      result: { proof: "", proof_facts: [], l2_to_l1_messages: [] },
    });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });

    await expect(service.proveTransaction("latest", MINIMAL_INVOKE_TX)).rejects.toThrow(
      /invalid result/
    );
  });

  it("proveTransaction succeeds through OHTTP path with valid result", async () => {
    const ohttpClient = mockOhttpClient({
      jsonrpc: "2.0",
      id: 1,
      result: DEFAULT_PROVE_RESULT,
    });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });
    const result = await service.proveTransaction("latest", MINIMAL_INVOKE_TX);

    expect(result.proof).toBe("YQ==");
    expect(result.proof_facts).toEqual([]);
    expect(result.l2_to_l1_messages).toEqual([]);
  });

  it("rejects extra fields in proveTransaction result through OHTTP path", async () => {
    const ohttpClient = mockOhttpClient({
      jsonrpc: "2.0",
      id: 1,
      result: { ...DEFAULT_PROVE_RESULT, extra_field: "ignored" },
    });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });

    await expect(service.proveTransaction("latest", MINIMAL_INVOKE_TX)).rejects.toThrow(
      /invalid result/
    );
  });

  it("rejects invalid l2_to_l1_messages through OHTTP path", async () => {
    const ohttpClient = mockOhttpClient({
      jsonrpc: "2.0",
      id: 1,
      result: {
        ...DEFAULT_PROVE_RESULT,
        l2_to_l1_messages: [{ from_address: "0x1", to_address: "0x2" } as MessageToL1],
      },
    });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });

    await expect(service.proveTransaction("latest", MINIMAL_INVOKE_TX)).rejects.toThrow(
      /invalid result/
    );
  });

  it("isHealthy returns true through OHTTP path", async () => {
    const ohttpClient = mockOhttpClient({ jsonrpc: "2.0", id: 1, result: "0.10.0" });

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });
    const healthy = await service.isHealthy();

    expect(healthy).toBe(true);
  });

  it("isHealthy returns false when OHTTP request fails", async () => {
    const ohttpClient = {
      post: vi.fn().mockRejectedValue(new Error("OHTTP error")),
    } as unknown as OhttpClient;

    const service = new ProvingService({ baseUrl: PROVER_URL, ohttpClient });
    const healthy = await service.isHealthy();

    expect(healthy).toBe(false);
  });
});
