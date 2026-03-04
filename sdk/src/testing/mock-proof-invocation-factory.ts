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
    details: ProofInvocationFactoryDetails
  ): Promise<ProofInvocation> {
    // Build INVOKE_TXN_V3 directly (without buildTransaction) so the raw
    // JSON string in calldata is preserved for MockProofProvider to parse.
    const poolAddressHex = toHex(poolAddress);
    const rb = details.resourceBounds ?? {
      l1_gas: { max_amount: 0n, max_price_per_unit: 0n },
      l2_gas: { max_amount: 0n, max_price_per_unit: 0n },
      l1_data_gas: { max_amount: 0n, max_price_per_unit: 0n },
    };
    return {
      type: "INVOKE",
      sender_address: poolAddressHex,
      calldata: [
        toHex(user.address),
        toHex(user.viewingKey),
        JSON.stringify(clientActions, jsonReplacer),
      ],
      signature: [],
      nonce: toHex(details.nonce ?? 0n),
      resource_bounds: {
        l1_gas: {
          max_amount: toHex(rb.l1_gas.max_amount),
          max_price_per_unit: toHex(rb.l1_gas.max_price_per_unit),
        },
        l2_gas: {
          max_amount: toHex(rb.l2_gas.max_amount),
          max_price_per_unit: toHex(rb.l2_gas.max_price_per_unit),
        },
        l1_data_gas: {
          max_amount: toHex(rb.l1_data_gas?.max_amount ?? 0n),
          max_price_per_unit: toHex(rb.l1_data_gas?.max_price_per_unit ?? 0n),
        },
      },
      tip: toHex(details.tip ?? 0n),
      paymaster_data: (details.paymasterData ?? []).map((x) => toHex(x)),
      account_deployment_data: (details.accountDeploymentData ?? []).map((x) => toHex(x)),
      nonce_data_availability_mode: details.nonceDataAvailabilityMode ?? "L1",
      fee_data_availability_mode: details.feeDataAvailabilityMode ?? "L1",
      version: "0x3",
    };
  }

  parseOutput(output: string[]): CallResult {
    // Mock output is already in a usable format
    return output;
  }
}
