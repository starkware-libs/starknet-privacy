import { describe, expect, it, vi, afterEach } from "vitest";
import { ProvingService, ProvingServiceError } from "../../src/internal/proving-service.js";
import {
  ScreeningRejected,
  ScreeningUnavailable,
  screeningErrorFromProvingError,
} from "../../src/internal/errors.js";

const PROVER_URL = "https://prover.test";

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

const BASE_RESULT = {
  proof: "YQ==",
  proof_facts: [] as string[],
  l2_to_l1_messages: [] as Array<{ from_address: string; to_address: string; payload: string[] }>,
};

function mockProveResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ jsonrpc: "2.0", id: 1, result })),
  } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe("prove response additional_data parsing", () => {
  it("parses additional_data.signature when present", async () => {
    const signature = {
      issued_at: 1716579600,
      sig_r: "0x6e6f63c878a2fdebb3934de2344fbd4bc04ae47b73561f2a5a170cd0c8a0cb",
      sig_s: "0x58a68a71ca79df6cc71d5b4b4813685f590ede2c686b9096fb350f11298429f",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockProveResponse({ ...BASE_RESULT, additional_data: { signature } })
    );

    const service = new ProvingService({ baseUrl: PROVER_URL });
    const result = await service.proveTransaction("latest", MINIMAL_INVOKE_TX);

    expect(result.additional_data?.signature).toEqual(signature);
  });

  it("parses a response without additional_data (backward compatible)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockProveResponse(BASE_RESULT));

    const service = new ProvingService({ baseUrl: PROVER_URL });
    const result = await service.proveTransaction("latest", MINIMAL_INVOKE_TX);

    expect(result.additional_data).toBeUndefined();
    expect(result.proof).toBe("YQ==");
  });

  it("still rejects an unknown top-level field (strict schema preserved)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockProveResponse({ ...BASE_RESULT, surprise_field: "nope" })
    );

    const service = new ProvingService({ baseUrl: PROVER_URL });
    await expect(service.proveTransaction("latest", MINIMAL_INVOKE_TX)).rejects.toThrow(
      /invalid result/
    );
  });

  it("rejects an unknown field inside additional_data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockProveResponse({ ...BASE_RESULT, additional_data: { unexpected: "x" } })
    );

    const service = new ProvingService({ baseUrl: PROVER_URL });
    await expect(service.proveTransaction("latest", MINIMAL_INVOKE_TX)).rejects.toThrow(
      /invalid result/
    );
  });

  it("rejects a signature missing a required felt field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockProveResponse({
        ...BASE_RESULT,
        additional_data: { signature: { issued_at: 1, sig_r: "0x1" } },
      })
    );

    const service = new ProvingService({ baseUrl: PROVER_URL });
    await expect(service.proveTransaction("latest", MINIMAL_INVOKE_TX)).rejects.toThrow(
      /invalid result/
    );
  });
});

describe("screeningErrorFromProvingError", () => {
  it("maps code 10000 + screening_unavailable to ScreeningUnavailable", () => {
    const mapped = screeningErrorFromProvingError(
      new ProvingServiceError(10000, "Transaction rejected", "screening_unavailable")
    );
    expect(mapped).toBeInstanceOf(ScreeningUnavailable);
  });

  it("maps code 10000 + address_blocked to ScreeningRejected", () => {
    const mapped = screeningErrorFromProvingError(
      new ProvingServiceError(10000, "Transaction rejected", "address_blocked")
    );
    expect(mapped).toBeInstanceOf(ScreeningRejected);
  });

  it("returns undefined for code 10000 with no data (not a screening verdict)", () => {
    const mapped = screeningErrorFromProvingError(
      new ProvingServiceError(10000, "Transaction rejected")
    );
    expect(mapped).toBeUndefined();
  });

  it("returns undefined for code 10000 from a non-screening block or interceptor fault", () => {
    // The interceptor reuses 10000 for non-pool blocks and unexpected
    // exceptions; those must NOT be misclassified as a terminal sanctions
    // rejection, or the caller would never retry a transient fault.
    for (const data of [
      "transaction is not a direct call to the privacy pool",
      "network timeout",
    ]) {
      const mapped = screeningErrorFromProvingError(
        new ProvingServiceError(10000, "Transaction rejected", data)
      );
      expect(mapped).toBeUndefined();
    }
  });

  it("returns undefined for a non-screening error code", () => {
    const mapped = screeningErrorFromProvingError(
      new ProvingServiceError(55, "Account validation failed")
    );
    expect(mapped).toBeUndefined();
  });
});
