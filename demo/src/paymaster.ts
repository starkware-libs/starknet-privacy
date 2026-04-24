import { hash, stark, type Call, type TypedData } from "starknet";

export type FeeMode = {
  mode: "sponsored_private";
  pool_fee_token: string;
  tip?: "low" | "normal" | "high";
};

export type FeeAction = {
  type: "withdraw";
  recipient: string;
  token: string;
  amount: string;
};

export type PaymasterCall = {
  to: string;
  selector: string;
  calldata: string[];
};

type BuildApplyActionResponse = {
  type: "apply_action";
  fee_action: FeeAction;
};

type BuildInvokeAndApplyActionResponse = {
  type: "invoke_and_apply_action";
  fee_action: FeeAction;
  typed_data: TypedData;
};

type ExecuteResponse = {
  transaction_hash: string;
};

const PARAMETERS = { version: "0x1" } as const;

async function rpcCall<T>(url: string, method: string, params: unknown, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-paymaster-api-key"] = apiKey;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await response.json();
  if (json.error) {
    const data = json.error.data;
    let dataDetail = "";
    if (typeof data === "string") dataDetail = `: ${data}`;
    else if (data && typeof data === "object") {
      const execError = (data as { execution_error?: string }).execution_error;
      dataDetail = `: ${execError ?? JSON.stringify(data)}`;
    }
    throw new Error(`Paymaster ${method}: ${json.error.message} (code: ${json.error.code})${dataDetail}`);
  }
  return json.result as T;
}

export function toPaymasterCall(call: Call): PaymasterCall {
  return {
    to: call.contractAddress,
    selector: hash.getSelectorFromName(call.entrypoint),
    calldata: call.calldata as string[],
  };
}

export async function paymasterBuildApplyAction(
  url: string,
  poolAddress: string,
  feeMode: FeeMode,
  apiKey?: string,
): Promise<BuildApplyActionResponse> {
  return rpcCall(url, "paymaster_buildTransaction", {
    transaction: { type: "apply_action", apply_action: { pool_address: poolAddress } },
    parameters: { ...PARAMETERS, fee_mode: feeMode },
  }, apiKey);
}

export async function paymasterBuildInvokeAndApplyAction(
  url: string,
  poolAddress: string,
  feeMode: FeeMode,
  userAddress: string,
  calls: PaymasterCall[],
  apiKey?: string,
): Promise<BuildInvokeAndApplyActionResponse> {
  return rpcCall(url, "paymaster_buildTransaction", {
    transaction: {
      type: "invoke_and_apply_action",
      apply_action: { pool_address: poolAddress },
      invoke: { user_address: userAddress, calls },
    },
    parameters: { ...PARAMETERS, fee_mode: feeMode },
  }, apiKey);
}

export async function paymasterExecuteApplyAction(
  url: string,
  applyActionsCall: PaymasterCall,
  proof: string,
  proofFacts: string[],
  feeMode: FeeMode,
  apiKey?: string,
): Promise<ExecuteResponse> {
  return rpcCall(url, "paymaster_executeTransaction", {
    transaction: {
      type: "apply_action",
      apply_action: { apply_actions_call: applyActionsCall, proof, proof_facts: proofFacts },
    },
    parameters: { ...PARAMETERS, fee_mode: feeMode },
  }, apiKey);
}

export async function paymasterExecuteInvokeAndApplyAction(
  url: string,
  applyActionsCall: PaymasterCall,
  proof: string,
  proofFacts: string[],
  feeMode: FeeMode,
  userAddress: string,
  typedData: TypedData,
  signature: string[],
  apiKey?: string,
): Promise<ExecuteResponse> {
  return rpcCall(url, "paymaster_executeTransaction", {
    transaction: {
      type: "invoke_and_apply_action",
      apply_action: { apply_actions_call: applyActionsCall, proof, proof_facts: proofFacts },
      invoke: { user_address: userAddress, typed_data: typedData, signature },
    },
    parameters: { ...PARAMETERS, fee_mode: feeMode },
  }, apiKey);
}

/** Normalize a starknet.js Signature to string[] for the paymaster. */
export function normalizeSignature(signature: unknown): string[] {
  if (Array.isArray(signature)) return signature.map(String);
  return stark.formatSignature(signature as Parameters<typeof stark.formatSignature>[0]);
}
