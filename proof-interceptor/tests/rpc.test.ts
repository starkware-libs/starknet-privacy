// tests/rpc.test.ts
import { describe, it, expect } from "vitest";
import { validateRpcRequest } from "../src/rpc.js";

function rpcBody(
  method: string,
  params?: unknown,
  overrides?: Record<string, unknown>
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
    ...overrides,
  });
}

function sampleInvokeV3(): Record<string, unknown> {
  return {
    type: "INVOKE",
    version: "0x3",
    sender_address: "0x123",
    calldata: ["0x1"],
    signature: ["0x2"],
    nonce: "0x0",
    resource_bounds: {},
    tip: "0x0",
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: "L1",
    fee_data_availability_mode: "L1",
  };
}

describe("validateRpcRequest", () => {
  describe("parse errors", () => {
    it("returns error for invalid JSON", () => {
      const result = validateRpcRequest("not json");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(-32600);
      }
    });

    it("returns error for missing jsonrpc field", () => {
      const result = validateRpcRequest(
        JSON.stringify({ id: 1, method: "foo" })
      );
      expect(result.ok).toBe(false);
    });

    it("returns error for missing method", () => {
      const result = validateRpcRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 1 })
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("starknet_checkTransaction", () => {
    it("validates valid INVOKE V3 transaction with request id", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["latest", sampleInvokeV3()])
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.requestId).toBe(1);
      }
    });

    it("validates with block hash", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", [
          { block_hash: "0xabc" },
          sampleInvokeV3(),
        ])
      );
      expect(result.ok).toBe(true);
    });

    it("validates with block number", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", [
          { block_number: 42 },
          sampleInvokeV3(),
        ])
      );
      expect(result.ok).toBe(true);
    });

    it("rejects pending block with BLOCK_NOT_FOUND (24)", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["pending", sampleInvokeV3()])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(24);
      }
    });

    it("rejects DECLARE transaction with UNSUPPORTED_TX_VERSION (61)", () => {
      const tx = { ...sampleInvokeV3(), type: "DECLARE" };
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["latest", tx])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(61);
        expect(result.response.error.data).toContain("DECLARE");
      }
    });

    it("rejects DEPLOY_ACCOUNT transaction with UNSUPPORTED_TX_VERSION (61)", () => {
      const tx = { ...sampleInvokeV3(), type: "DEPLOY_ACCOUNT" };
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["latest", tx])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(61);
      }
    });

    it("rejects wrong invoke version with UNSUPPORTED_TX_VERSION (61)", () => {
      const tx = { ...sampleInvokeV3(), version: "0x1" };
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["latest", tx])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(61);
        expect(result.response.error.data).toContain("0x1");
      }
    });

    it("rejects missing params", () => {
      const result = validateRpcRequest(rpcBody("starknet_checkTransaction"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(-32600);
      }
    });

    it("rejects non-object transaction", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["latest", "not-an-object"])
      );
      expect(result.ok).toBe(false);
    });

    it("rejects transaction with missing calldata", () => {
      const tx = { ...sampleInvokeV3() };
      delete tx.calldata;
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["latest", tx])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(-32600);
      }
    });

    it("rejects transaction with non-array calldata", () => {
      const tx = { ...sampleInvokeV3(), calldata: "not-an-array" };
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["latest", tx])
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(-32600);
      }
    });

    describe("object-form params (by-name)", () => {
      it("accepts object params with block_id and transaction", () => {
        const result = validateRpcRequest(
          rpcBody("starknet_checkTransaction", {
            block_id: "latest",
            transaction: sampleInvokeV3(),
          })
        );
        expect(result.action).toBe(RpcAction.CheckWithInterceptors);
      });

      it("accepts object params with block_hash block_id", () => {
        const result = validateRpcRequest(
          rpcBody("starknet_checkTransaction", {
            block_id: { block_hash: "0xabc" },
            transaction: sampleInvokeV3(),
          })
        );
        expect(result.action).toBe(RpcAction.CheckWithInterceptors);
      });

      it("rejects object params with pending block_id as BLOCK_NOT_FOUND (24)", () => {
        const result = validateRpcRequest(
          rpcBody("starknet_checkTransaction", {
            block_id: "pending",
            transaction: sampleInvokeV3(),
          })
        );
        expect(result.action).toBe(RpcAction.Error);
        if (result.action === RpcAction.Error) {
          expect(result.response.error.code).toBe(24);
        }
      });

      it("rejects object params missing block_id", () => {
        const result = validateRpcRequest(
          rpcBody("starknet_checkTransaction", {
            transaction: sampleInvokeV3(),
          })
        );
        expect(result.action).toBe(RpcAction.Error);
        if (result.action === RpcAction.Error) {
          expect(result.response.error.code).toBe(-32600);
        }
      });

      it("rejects object params missing transaction", () => {
        const result = validateRpcRequest(
          rpcBody("starknet_checkTransaction", { block_id: "latest" })
        );
        expect(result.action).toBe(RpcAction.Error);
        if (result.action === RpcAction.Error) {
          expect(result.response.error.code).toBe(-32600);
        }
      });

      it("rejects object params with non-object transaction", () => {
        const result = validateRpcRequest(
          rpcBody("starknet_checkTransaction", {
            block_id: "latest",
            transaction: "not-an-object",
          })
        );
        expect(result.action).toBe(RpcAction.Error);
      });

      it("rejects primitive params", () => {
        const result = validateRpcRequest(
          rpcBody("starknet_checkTransaction", "not-an-object-or-array")
        );
        expect(result.action).toBe(RpcAction.Error);
        if (result.action === RpcAction.Error) {
          expect(result.response.error.code).toBe(-32600);
        }
      });
    });
  });

  describe("unknown methods", () => {
    it("rejects unknown method", () => {
      const result = validateRpcRequest(rpcBody("starknet_unknownMethod"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(-32601);
      }
    });

    it("rejects starknet_specVersion as unsupported", () => {
      const result = validateRpcRequest(rpcBody("starknet_specVersion"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.error.code).toBe(-32601);
      }
    });
  });

  describe("request id preservation", () => {
    it("preserves string id in error response", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_checkTransaction", ["pending", sampleInvokeV3()], {
          id: "my-request-id",
        })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.id).toBe("my-request-id");
      }
    });

    it("preserves numeric id in error response", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_unknownMethod", undefined, { id: 42 })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.id).toBe(42);
      }
    });
  });
});
