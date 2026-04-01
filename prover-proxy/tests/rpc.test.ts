// tests/rpc.test.ts
import { describe, it, expect } from "vitest";
import { RpcAction, validateRpcRequest } from "../src/rpc.js";

function rpcBody(
  method: string,
  params?: unknown[],
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
  const defaultOptions = { forwardUnknownMethods: false };

  describe("parse errors", () => {
    it("returns error for invalid JSON", () => {
      const result = validateRpcRequest("not json", defaultOptions);
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(-32600);
      }
    });

    it("returns error for missing jsonrpc field", () => {
      const result = validateRpcRequest(
        JSON.stringify({ id: 1, method: "foo" }),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
    });

    it("returns error for missing method", () => {
      const result = validateRpcRequest(
        JSON.stringify({ jsonrpc: "2.0", id: 1 }),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
    });
  });

  describe("starknet_specVersion", () => {
    it("forwards starknet_specVersion", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_specVersion"),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.ForwardAsIs);
    });
  });

  describe("starknet_proveTransaction", () => {
    it("forwards valid INVOKE V3 transaction", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["latest", sampleInvokeV3()]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.ForwardAsIs);
    });

    it("forwards with block hash", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", [
          { block_hash: "0xabc" },
          sampleInvokeV3(),
        ]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.ForwardAsIs);
    });

    it("forwards with block number", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", [
          { block_number: 42 },
          sampleInvokeV3(),
        ]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.ForwardAsIs);
    });

    it("rejects pending block with BLOCK_NOT_FOUND (24)", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["pending", sampleInvokeV3()]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(24);
      }
    });

    it("rejects DECLARE transaction with UNSUPPORTED_TX_VERSION (61)", () => {
      const tx = { ...sampleInvokeV3(), type: "DECLARE" };
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["latest", tx]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(61);
        expect(result.response.error.data).toContain("DECLARE");
      }
    });

    it("rejects DEPLOY_ACCOUNT transaction with UNSUPPORTED_TX_VERSION (61)", () => {
      const tx = { ...sampleInvokeV3(), type: "DEPLOY_ACCOUNT" };
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["latest", tx]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(61);
      }
    });

    it("rejects wrong invoke version with UNSUPPORTED_TX_VERSION (61)", () => {
      const tx = { ...sampleInvokeV3(), version: "0x1" };
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["latest", tx]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(61);
        expect(result.response.error.data).toContain("0x1");
      }
    });

    it("rejects missing params", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction"),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(-32600);
      }
    });

    it("rejects non-object transaction", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["latest", "not-an-object"]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
    });

    it("rejects transaction with missing calldata", () => {
      const tx = { ...sampleInvokeV3() };
      delete tx.calldata;
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["latest", tx]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(-32600);
      }
    });

    it("rejects transaction with non-array calldata", () => {
      const tx = { ...sampleInvokeV3(), calldata: "not-an-array" };
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["latest", tx]),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(-32600);
      }
    });
  });

  describe("unknown methods", () => {
    it("rejects unknown method by default", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_unknownMethod"),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.error.code).toBe(-32601);
      }
    });

    it("forwards unknown method when configured", () => {
      const result = validateRpcRequest(rpcBody("starknet_unknownMethod"), {
        forwardUnknownMethods: true,
      });
      expect(result.action).toBe(RpcAction.ForwardAsIs);
    });
  });

  describe("request id preservation", () => {
    it("preserves string id in error response", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_proveTransaction", ["pending", sampleInvokeV3()], {
          id: "my-request-id",
        }),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.id).toBe("my-request-id");
      }
    });

    it("preserves numeric id in error response", () => {
      const result = validateRpcRequest(
        rpcBody("starknet_unknownMethod", undefined, { id: 42 }),
        defaultOptions
      );
      expect(result.action).toBe(RpcAction.Error);
      if (result.action === RpcAction.Error) {
        expect(result.response.id).toBe(42);
      }
    });
  });
});
