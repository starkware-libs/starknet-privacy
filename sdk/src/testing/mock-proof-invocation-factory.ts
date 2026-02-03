/**
 * Mock ProofInvocationFactory implementation for testing.
 *
 * Simply passes through the client actions without serialization.
 * The MockProofProvider will use these directly with MockPoolContract.
 */

import type { ClientAction } from "../internal/client-actions.js";
import type {
  ProofInvocationFactoryInterface,
  ProofUser,
} from "../internal/proof-invocation-factory.js";
import type {
  ProofInvocation,
  ProofInvocationFactoryDetails,
  StarknetAddress,
} from "../interfaces.js";
import type { CallResult } from "starknet";
import { Open } from "../interfaces.js";
import { toHex } from "../utils/convert.js";

/**
 * JSON replacer that converts BigInts and Symbols to strings with prefix markers.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return `__bigint__${value.toString()}`;
  }
  if (typeof value === "symbol" && value === Open) {
    return "__symbol__Open";
  }
  return value;
}

/**
 * JSON reviver that converts prefixed strings back to BigInts and Symbols.
 */
export function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("__bigint__")) {
      return BigInt(value.slice(10));
    }
    if (value === "__symbol__Open") {
      return Open;
    }
  }
  return value;
}

/**
 * Mock implementation - creates a minimal ProofInvocation for testing.
 * The calldata contains just the user address and client actions for the mock pool.
 */
export class MockProofInvocationFactory implements ProofInvocationFactoryInterface {
  async create(
    user: ProofUser,
    poolAddress: StarknetAddress,
    clientActions: ClientAction[],
    _details: ProofInvocationFactoryDetails
  ): Promise<ProofInvocation> {
    // For mock, we store the client actions in a way the mock pool can use
    // The mock proof provider will extract and process these
    const poolAddressHex = toHex(poolAddress);
    return {
      contractAddress: poolAddressHex,
      calldata: [
        toHex(user.address),
        toHex(user.viewingKey),
        JSON.stringify(clientActions, jsonReplacer),
      ],
      signature: [],
    };
  }

  parseOutput(output: string[]): CallResult {
    // Mock output is already in a usable format
    return output;
  }
}
