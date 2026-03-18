import { describe, expect, it, vi, afterEach } from "vitest";
import { PaymasterService } from "../../../src/internal/paymaster/service.js";

const PAYMASTER_URL = "https://paymaster.test";

const VALID_FEE_SCHEDULE = {
  feeRecipient: "0xfee",
  baseFee: "1000",
  perAction: {
    writeOnce: "100",
    append: "150",
    transferFrom: "200",
    transferTo: "200",
    emitViewingKeySet: "50",
    emitWithdrawal: "50",
    emitDeposit: "50",
    emitOpenNoteCreated: "50",
    emitEncNoteCreated: "50",
    emitNoteUsed: "50",
    invoke: { "0xbeef": "500" },
  },
  gasPrice: "10",
  validUntil: Math.floor(Date.now() / 1000) + 600, // 10 min from now
};

function mockJsonRpcResponse(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ jsonrpc: "2.0", id: 1, result })),
  } as Response;
}

function getRequestBody<T = Record<string, unknown>>(mockFetch: ReturnType<typeof vi.fn>): T {
  const init = mockFetch.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string) as T;
}

describe("PaymasterService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getFeeQuote", () => {
    it("sends correct JSON-RPC method and token param", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockJsonRpcResponse(VALID_FEE_SCHEDULE));

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      await service.getFeeQuote("0xabc123");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = getRequestBody<{ method: string; params: { token: string } }>(fetchSpy);
      expect(body.method).toBe("paymaster_getFeeQuote");
      expect(body.params.token).toBe("0xabc123");
    });

    it("returns valid fee schedule", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonRpcResponse(VALID_FEE_SCHEDULE));

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      const schedule = await service.getFeeQuote("0xabc123");

      expect(schedule.feeRecipient).toBe("0xfee");
      expect(schedule.baseFee).toBe("1000");
      expect(schedule.perAction.writeOnce).toBe("100");
      expect(schedule.perAction.invoke["0xbeef"]).toBe("500");
      expect(schedule.validUntil).toBe(VALID_FEE_SCHEDULE.validUntil);
    });

    it("rejects malformed fee schedule (missing feeRecipient)", async () => {
      const malformed = { ...VALID_FEE_SCHEDULE, feeRecipient: undefined };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonRpcResponse(malformed));

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      await expect(service.getFeeQuote("0xabc123")).rejects.toThrow(/invalid fee schedule/);
    });

    it("rejects malformed fee schedule (missing perAction field)", async () => {
      const malformed = {
        ...VALID_FEE_SCHEDULE,
        perAction: { ...VALID_FEE_SCHEDULE.perAction, writeOnce: undefined },
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonRpcResponse(malformed));

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      await expect(service.getFeeQuote("0xabc123")).rejects.toThrow(/invalid fee schedule/);
    });

    it("caches fee schedule for same token and returns cached on second call", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockJsonRpcResponse(VALID_FEE_SCHEDULE));

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      const first = await service.getFeeQuote("0xabc123");
      const second = await service.getFeeQuote("0xabc123");

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(first).toEqual(second);
    });

    it("re-fetches when cached schedule has expired", async () => {
      const expiredSchedule = {
        ...VALID_FEE_SCHEDULE,
        validUntil: Math.floor(Date.now() / 1000) - 10, // expired 10s ago
      };

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(mockJsonRpcResponse(expiredSchedule))
        .mockResolvedValueOnce(mockJsonRpcResponse(VALID_FEE_SCHEDULE));

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      await service.getFeeQuote("0xabc123");
      const second = await service.getFeeQuote("0xabc123");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(second.validUntil).toBe(VALID_FEE_SCHEDULE.validUntil);
    });

    it("fetches separately for different tokens", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockJsonRpcResponse(VALID_FEE_SCHEDULE));

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      await service.getFeeQuote("0xaaa111");
      await service.getFeeQuote("0xbbb222");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling", () => {
    it("throws on JSON-RPC error response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32600, message: "Invalid request" },
            })
          ),
      } as Response);

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      await expect(service.getFeeQuote("0xabc123")).rejects.toThrow(
        /Paymaster service error \(code -32600\)/
      );
    });

    it("throws on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("Service Unavailable"),
      } as Response);

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      await expect(service.getFeeQuote("0xabc123")).rejects.toThrow(/Paymaster service HTTP 503/);
    });

    it("throws when response has no result", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
      } as Response);

      const service = new PaymasterService({ baseUrl: PAYMASTER_URL });
      await expect(service.getFeeQuote("0xabc123")).rejects.toThrow(
        /Paymaster service returned no result/
      );
    });
  });
});
