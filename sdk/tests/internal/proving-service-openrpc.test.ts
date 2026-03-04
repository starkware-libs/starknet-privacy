/**
 * Tests the SDK's ProvingService (src/internal/proving-service.ts) against the
 * OpenRPC proving API spec from the sequencer repo. We assert that the methods
 * it calls, the request shapes it sends, and the response shapes it expects
 * match the spec. Spec is loaded from tests/fixtures/proving_api_openrpc.json
 * (committed copy; CI runs npm run fetch:proving-spec to test against latest).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { Ajv } from "ajv";
import {
  ProvingService,
  type MessageToL1,
} from "../../src/internal/proving-service.js";

const PROVER_URL = "https://prover.test";

/** Path to the committed spec fixture (relative to sdk/ when tests run from sdk). */
const SPEC_FIXTURE_PATH = "tests/fixtures/proving_api_openrpc.json";

interface ProvingApiOpenRPCSpec {
  openrpc: string;
  info?: { version?: string; title?: string };
  methods: Array<{ name: string; params: Array<{ name: string }> }>;
  components?: {
    schemas?: Record<
      string,
      {
        type?: string;
        required?: string[];
        properties?: Record<string, unknown>;
        items?: { $ref?: string };
      }
    >;
  };
}

function isProvingApiSpec(obj: unknown): obj is ProvingApiOpenRPCSpec {
  if (obj === null || typeof obj !== "object") return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s.openrpc === "string" &&
    Array.isArray(s.methods) &&
    s.methods.every(
      (m: unknown) =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as Record<string, unknown>).name === "string" &&
        Array.isArray((m as Record<string, unknown>).params)
    )
  );
}

async function loadProvingApiSpec(): Promise<ProvingApiOpenRPCSpec | null> {
  const specPath = join(process.cwd(), SPEC_FIXTURE_PATH);
  try {
    const raw = await readFile(specPath, "utf-8");
    const json = JSON.parse(raw) as unknown;
    if (!isProvingApiSpec(json)) return null;
    return json;
  } catch {
    return null;
  }
}

const SDK_PROVING_METHODS = ["starknet_specVersion", "starknet_proveTransaction"] as const;
const PROVE_TRANSACTION_RESULT_KEYS = ["proof", "proof_facts", "l2_to_l1_messages"] as const;
const MSG_TO_L1_KEYS = ["from_address", "to_address", "payload"] as const;
const SPEC_PARAM_COUNTS: Array<[string, number]> = [
  ["starknet_specVersion", 0],
  ["starknet_proveTransaction", 2],
];

const SPEC_SCHEMA_ID = "spec";

function compileSchemaForRef(
  specDoc: ProvingApiOpenRPCSpec,
  refPath: string
): (value: unknown) => boolean {
  const ajv = new Ajv({ strict: false });
  const specWithId = {
    ...specDoc,
    $id: SPEC_SCHEMA_ID,
  } as Record<string, unknown>;
  ajv.addSchema(specWithId as never, SPEC_SCHEMA_ID);
  const refSchema = { $ref: `${SPEC_SCHEMA_ID}#/${refPath}` };
  const validate = ajv.compile(refSchema as never);
  return (value: unknown) => validate(value) as boolean;
}

/** Minimal INVOKE v3 transaction for request tests (matches spec RPC_TRANSACTION). */
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

function mockSpecVersionResponse(version = "0.10.0"): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ jsonrpc: "2.0", id: 1, result: version })),
  } as Response;
}

function mockProveTransactionResponse(
  result: typeof DEFAULT_PROVE_RESULT = DEFAULT_PROVE_RESULT
): Response {
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

let spec: ProvingApiOpenRPCSpec | null = null;

beforeAll(async () => {
  spec = await loadProvingApiSpec();
  if (!spec) {
    throw new Error(
      "Proving API spec not found: run 'npm run fetch:proving-spec' to download tests/fixtures/proving_api_openrpc.json."
    );
  }
});

describe("ProvingService (proving-service.ts) vs OpenRPC spec", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("spec validity", () => {
    it("loaded spec is valid OpenRPC with expected methods and schemas", () => {
      expect(spec).not.toBeNull();
      expect(spec!.openrpc).toBeDefined();
      expect(spec!.methods).toBeDefined();
      expect(Array.isArray(spec!.methods)).toBe(true);
      expect(spec!.components?.schemas).toBeDefined();

      const methodNames = spec!.methods.map((m) => m.name);
      for (const name of SDK_PROVING_METHODS) {
        expect(methodNames).toContain(name);
      }

      expect(spec!.components!.schemas!["PROVE_TRANSACTION_RESULT"]).toBeDefined();
      expect(spec!.components!.schemas!["MSG_TO_L1"]).toBeDefined();
      expect(spec!.components!.schemas!["BLOCK_ID"]).toBeDefined();
    });
  });

  describe("spec methods match SDK methods", () => {
    it("every SDK method exists in spec (client mirror of spec_methods_match_rpc_module)", () => {
      expect(spec).not.toBeNull();
      const specMethodNames = new Set(spec!.methods.map((m) => m.name));
      for (const name of SDK_PROVING_METHODS) {
        expect(specMethodNames.has(name)).toBe(true);
      }
    });
  });

  describe("spec parameter count matches methods", () => {
    it("each method has expected param count (mirrors sequencer spec_parameter_count_matches_methods)", () => {
      expect(spec).not.toBeNull();
      const byName = new Map(spec!.methods.map((m) => [m.name, m]));
      for (const [methodName, expectedCount] of SPEC_PARAM_COUNTS) {
        const method = byName.get(methodName);
        expect(method).toBeDefined();
        const actualCount = method!.params.length;
        expect(actualCount).toBe(expectedCount);
      }
    });
  });

  describe("request shape (ProvingService.send)", () => {
    it("getSpecVersion sends method starknet_specVersion and params []", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockSpecVersionResponse());

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await service.getSpecVersion();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect((fetchSpy.mock.calls[0] as [string])[0]).toBe(PROVER_URL);
      const body = getRequestBody<{ method: string; params: unknown }>(fetchSpy);
      expect(body.method).toBe("starknet_specVersion");
      expect(body.params).toEqual([]);
    });

    it("proveTransaction sends method starknet_proveTransaction with block_id and transaction", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockProveTransactionResponse());

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await service.proveTransaction("latest", MINIMAL_INVOKE_TX);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = getRequestBody<{
        method: string;
        params: Record<string, unknown>;
      }>(fetchSpy);
      expect(body.method).toBe("starknet_proveTransaction");
      expect(body.params).toHaveProperty("block_id");
      expect(body.params).toHaveProperty("transaction");
      expect(body.params.block_id).toBe("latest");
      expect(body.params.transaction).toEqual(MINIMAL_INVOKE_TX);
    });

    it("proveTransaction with block_number sends block_id as object", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockProveTransactionResponse());

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await service.proveTransaction(42, MINIMAL_INVOKE_TX);

      const body = getRequestBody<{ params: Record<string, unknown> }>(fetchSpy);
      expect(body.params.block_id).toEqual({ block_number: 42 });
    });

    it('proveTransaction with pending sends block_id as "pending"', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockProveTransactionResponse());

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await service.proveTransaction("pending", MINIMAL_INVOKE_TX);

      const body = getRequestBody<{ params: Record<string, unknown> }>(fetchSpy);
      expect(body.params.block_id).toBe("pending");
    });

    it("proveTransaction with block_hash sends block_id as object", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockProveTransactionResponse());

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await service.proveTransaction(
        { block_hash: "0xabc" } as unknown as Parameters<ProvingService["proveTransaction"]>[0],
        MINIMAL_INVOKE_TX
      );

      const body = getRequestBody<{ params: Record<string, unknown> }>(fetchSpy);
      expect(body.params.block_id).toEqual({ block_hash: "0xabc" });
    });
  });

  describe("serialized block_id matches schema", () => {
    it("BLOCK_ID schema validates latest, block_number, block_hash (mirrors sequencer serialized_block_id_matches_schema)", () => {
      expect(spec).not.toBeNull();
      const validate = compileSchemaForRef(spec!, "components/schemas/BLOCK_ID");

      expect(validate("latest")).toBe(true);
      expect(validate("pending")).toBe(true);
      expect(validate({ block_number: 42 })).toBe(true);
      expect(validate({ block_number: 0 })).toBe(true);
      expect(validate({ block_hash: "0x123" })).toBe(true);
      expect(validate({ block_hash: "0xabc" })).toBe(true);
    });
  });

  describe("serialized rpc_transaction matches schema", () => {
    it("RPC_TRANSACTION schema validates minimal invoke tx (mirrors sequencer serialized_rpc_transaction_matches_schema)", () => {
      expect(spec).not.toBeNull();
      const validate = compileSchemaForRef(spec!, "components/schemas/RPC_TRANSACTION");
      expect(validate(MINIMAL_INVOKE_TX)).toBe(true);
    });
  });

  describe("response shape (unhappy) — ProvingService rejects invalid result", () => {
    it("proveTransaction throws when l2_to_l1_messages item has missing required field (payload)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockProveTransactionResponse({
          ...DEFAULT_PROVE_RESULT,
          l2_to_l1_messages: [
            { from_address: "0x123", to_address: "0xdead" } as MessageToL1,
          ],
        })
      );

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/invalid result/);
    });

    it("proveTransaction throws when l2_to_l1_messages item has missing from_address", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockProveTransactionResponse({
          ...DEFAULT_PROVE_RESULT,
          l2_to_l1_messages: [
            { to_address: "0xdead", payload: ["0x1"] } as MessageToL1,
          ],
        })
      );

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/invalid result/);
    });

    it("proveTransaction throws when l2_to_l1_messages item has payload not an array", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockProveTransactionResponse({
          ...DEFAULT_PROVE_RESULT,
          l2_to_l1_messages: [
            {
              from_address: "0x123",
              to_address: "0xdead",
              payload: "not-an-array" as unknown as string[],
            },
          ],
        })
      );

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/invalid result/);
    });

    it("proveTransaction throws when proof is empty string", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockProveTransactionResponse({
          proof: "",
          proof_facts: [],
          l2_to_l1_messages: [],
        })
      );

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/invalid result/);
    });

    it("proveTransaction throws when proof is missing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockProveTransactionResponse({
          proof_facts: [],
          l2_to_l1_messages: [],
        } as unknown as typeof DEFAULT_PROVE_RESULT)
      );

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/invalid result/);
    });

    it("proveTransaction throws when proof_facts is not an array", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockProveTransactionResponse({
          proof: "YQ==",
          proof_facts: "not-array" as unknown as string[],
          l2_to_l1_messages: [],
        })
      );

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/invalid result/);
    });

    it("proveTransaction throws when l2_to_l1_messages is not an array", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockProveTransactionResponse({
          proof: "YQ==",
          proof_facts: [],
          l2_to_l1_messages: null as unknown as MessageToL1[],
        })
      );

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/invalid result/);
    });
  });

  describe("getSpecVersion / proveTransaction — RPC and HTTP unhappy", () => {
    it("proveTransaction throws when response is JSON-RPC error (e.g. block not found)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: 24, message: "Block not found" },
            })
          ),
      } as Response);

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/Proving service error \(code 24\)/);
    });

    it("proveTransaction throws when response has no result", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
      } as Response);

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/Proving service returned no result/);
    });

    it("proveTransaction throws when HTTP status is not ok", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("Service Unavailable"),
      } as Response);

      const service = new ProvingService({ baseUrl: PROVER_URL });
      await expect(
        service.proveTransaction("latest", MINIMAL_INVOKE_TX)
      ).rejects.toThrow(/Proving service HTTP 503/);
    });
  });

  describe("spec_version response matches schema", () => {
    it("getSpecVersion result validates against spec result schema (mirrors sequencer spec_version_response_matches_schema)", async () => {
      expect(spec).not.toBeNull();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockSpecVersionResponse());

      const service = new ProvingService({ baseUrl: PROVER_URL });
      const result = await service.getSpecVersion();

      const validate = compileSchemaForRef(spec!, "methods/0/result/schema");
      expect(validate(result)).toBe(true);
    });
  });

  describe("prove_transaction result matches schema", () => {
    it("PROVE_TRANSACTION_RESULT schema validates sample result (mirrors sequencer prove_transaction_result_matches_schema)", () => {
      expect(spec).not.toBeNull();
      const sampleResult = {
        proof: "YQ==",
        proof_facts: ["0xdead", "0xbeef"],
        l2_to_l1_messages: [
          {
            from_address: "0x123",
            to_address: "0xdead",
            payload: ["0x42"],
          },
        ],
      };
      const validate = compileSchemaForRef(spec!, "components/schemas/PROVE_TRANSACTION_RESULT");
      expect(validate(sampleResult)).toBe(true);
    });
  });

  describe("response shape (ProvingService result parsing)", () => {
    it("getSpecVersion result is a string (per spec)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockSpecVersionResponse());

      const service = new ProvingService({ baseUrl: PROVER_URL });
      const result = await service.getSpecVersion();

      expect(typeof result).toBe("string");
      expect(result).toBe("0.10.0");
    });

    it("proveTransaction result has PROVE_TRANSACTION_RESULT required fields (per spec)", async () => {
      const mockResult = {
        proof: "YQ==",
        proof_facts: ["0x1", "0x2"],
        l2_to_l1_messages: [
          {
            from_address: "0xabc",
            to_address: "0xdef",
            payload: ["0x1"],
          },
        ],
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockProveTransactionResponse(mockResult));

      const service = new ProvingService({ baseUrl: PROVER_URL });
      const result = await service.proveTransaction("latest", MINIMAL_INVOKE_TX);

      const resultKeys =
        spec!.components?.schemas?.["PROVE_TRANSACTION_RESULT"]?.required ??
        PROVE_TRANSACTION_RESULT_KEYS;
      for (const key of resultKeys) {
        expect(result).toHaveProperty(key);
      }
      expect(result.proof).toBe(mockResult.proof);
      expect(result.proof_facts).toEqual(mockResult.proof_facts);
      expect(Array.isArray(result.l2_to_l1_messages)).toBe(true);
    });

    it("proveTransaction l2_to_l1_messages items match MSG_TO_L1 (from_address, to_address, payload)", async () => {
      const msg = {
        from_address: "0xabc",
        to_address: "0xdef",
        payload: ["0x1", "0x2"],
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockProveTransactionResponse({
          ...DEFAULT_PROVE_RESULT,
          l2_to_l1_messages: [msg],
        })
      );

      const service = new ProvingService({ baseUrl: PROVER_URL });
      const result = await service.proveTransaction("latest", MINIMAL_INVOKE_TX);

      expect(result.l2_to_l1_messages.length).toBe(1);
      const msgKeys = spec!.components?.schemas?.["MSG_TO_L1"]?.required ?? MSG_TO_L1_KEYS;
      for (const key of msgKeys) {
        expect(result.l2_to_l1_messages[0]).toHaveProperty(key);
      }
      expect(result.l2_to_l1_messages[0].from_address).toBe(msg.from_address);
      expect(result.l2_to_l1_messages[0].to_address).toBe(msg.to_address);
      expect(result.l2_to_l1_messages[0].payload).toEqual(msg.payload);
    });
  });
});
