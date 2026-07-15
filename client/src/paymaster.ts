/**
 * Paymaster port for privacy submissions, plus the default AVNU adapter.
 *
 * A submission through a paymaster is a two-call flow (SNIP-29-style JSON-RPC, mirrored from the
 * reference in `demo/src/paymaster.ts`):
 *   1. {@link Paymaster.buildTransaction} quotes the fee as a {@link PaymasterFeeAction} — a `withdraw`
 *      (to the paymaster, for the fee token/amount) the caller adds to the action chain before proving.
 *      For an `invokeAndApplyAction` (deposits needing `approve`) it also returns `typedData` to sign.
 *   2. {@link Paymaster.executeTransaction} takes the proven `apply_actions` call + proof (+ the signed
 *      invoke for the `invokeAndApplyAction` case) and broadcasts it, returning the tx hash.
 *
 * `Paymaster` is injected via `build({ paymaster })`, so a dapp can swap providers or a fake in tests;
 * {@link AvnuPaymaster} is the shipped default.
 */

import { hash, stark } from "starknet";
import type { Call, Signature, TypedData } from "starknet";

/** Fee-payment mode. `sponsored_private` funds the fee from the pool via a fee-token withdrawal. */
export type PaymasterFeeMode = {
  mode: "sponsored_private";
  poolFeeToken: string;
  tip?: "low" | "normal" | "high";
};

/** The fee quote: a `withdraw` of `amount` `token` to the paymaster `recipient`, added to the chain. */
export type PaymasterFeeAction = {
  type: "withdraw";
  recipient: string;
  token: string;
  amount: string;
};

/** A Starknet call in the paymaster's wire shape (selector + raw calldata). */
export type PaymasterCall = {
  to: string;
  selector: string;
  calldata: string[];
};

/** `buildTransaction` request: apply actions on the pool, optionally with an invoke that needs approvals. */
export type PaymasterBuild =
  | { kind: "applyAction"; poolAddress: string }
  | {
      kind: "invokeAndApplyAction";
      poolAddress: string;
      userAddress: string;
      calls: PaymasterCall[];
    };

/** `buildTransaction` result: the fee quote, plus (invoke case) the typed data the user must sign. */
export type PaymasterQuote = {
  feeAction: PaymasterFeeAction;
  typedData?: TypedData;
};

/** `executeTransaction` request: the proven apply-actions call + proof, plus the signed invoke if any. */
export type PaymasterExecute =
  | { kind: "applyAction"; applyActionsCall: PaymasterCall; proof: string; proofFacts: string[] }
  | {
      kind: "invokeAndApplyAction";
      applyActionsCall: PaymasterCall;
      proof: string;
      proofFacts: string[];
      userAddress: string;
      typedData: TypedData;
      signature: string[];
    };

/** The paymaster the client drives for non-strk20 submissions. */
export interface Paymaster {
  /** Quote the fee (and, for the invoke case, the typed data to sign) for the given transaction. */
  buildTransaction(build: PaymasterBuild): Promise<PaymasterQuote>;
  /** Broadcast the proven transaction through the paymaster; resolves to the tx hash. */
  executeTransaction(execute: PaymasterExecute): Promise<{ transactionHash: string }>;
}

/** Convert a starknet.js {@link Call} into the paymaster wire shape. */
export function toPaymasterCall(call: Call): PaymasterCall {
  return {
    to: call.contractAddress,
    selector: hash.getSelectorFromName(call.entrypoint),
    calldata: (call.calldata ?? []) as string[],
  };
}

/** Normalize a starknet.js {@link Signature} to the `string[]` the paymaster expects. */
export function normalizeSignature(signature: Signature): string[] {
  if (Array.isArray(signature)) return signature.map(String);
  return stark.formatSignature(signature);
}

export interface AvnuPaymasterOptions {
  /** Paymaster JSON-RPC endpoint. */
  url: string;
  /** Fee mode (mode + pool fee token + tip) applied to every request. */
  feeMode: PaymasterFeeMode;
  /** Optional AVNU API key, sent as the `x-paymaster-api-key` header. */
  apiKey?: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
}

/** Wire representation of {@link PaymasterFeeMode} (snake_case, per the RPC). */
type WireFeeMode = { mode: string; pool_fee_token: string; tip?: string };

/** The default {@link Paymaster}: a thin JSON-RPC client for the AVNU privacy paymaster. */
export class AvnuPaymaster implements Paymaster {
  private readonly parameters: { version: "0x1"; fee_mode: WireFeeMode };
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: AvnuPaymasterOptions) {
    this.parameters = {
      version: "0x1",
      fee_mode: {
        mode: options.feeMode.mode,
        pool_fee_token: options.feeMode.poolFeeToken,
        ...(options.feeMode.tip !== undefined ? { tip: options.feeMode.tip } : {}),
      },
    };
    this.fetchFn = options.fetch ?? fetch;
  }

  async buildTransaction(build: PaymasterBuild): Promise<PaymasterQuote> {
    const transaction =
      build.kind === "applyAction"
        ? { type: "apply_action", apply_action: { pool_address: build.poolAddress } }
        : {
            type: "invoke_and_apply_action",
            apply_action: { pool_address: build.poolAddress },
            invoke: { user_address: build.userAddress, calls: build.calls },
          };
    const result = await this.rpc<{ fee_action: PaymasterFeeAction; typed_data?: TypedData }>(
      "paymaster_buildTransaction",
      { transaction, parameters: this.parameters }
    );
    return { feeAction: result.fee_action, typedData: result.typed_data };
  }

  async executeTransaction(execute: PaymasterExecute): Promise<{ transactionHash: string }> {
    const applyAction = {
      apply_actions_call: execute.applyActionsCall,
      proof: execute.proof,
      proof_facts: execute.proofFacts,
    };
    const transaction =
      execute.kind === "applyAction"
        ? { type: "apply_action", apply_action: applyAction }
        : {
            type: "invoke_and_apply_action",
            apply_action: applyAction,
            invoke: {
              user_address: execute.userAddress,
              typed_data: execute.typedData,
              signature: execute.signature,
            },
          };
    const result = await this.rpc<{ transaction_hash: string }>("paymaster_executeTransaction", {
      transaction,
      parameters: this.parameters,
    });
    return { transactionHash: result.transaction_hash };
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.apiKey) headers["x-paymaster-api-key"] = this.options.apiKey;
    const response = await this.fetchFn(this.options.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await response.json()) as {
      result?: T;
      error?: { message: string; code: number; data?: unknown };
    };
    if (json.error) {
      const { data } = json.error;
      let detail = "";
      if (typeof data === "string") detail = `: ${data}`;
      else if (data && typeof data === "object") {
        const execError = (data as { execution_error?: string }).execution_error;
        detail = `: ${execError ?? JSON.stringify(data)}`;
      }
      throw new Error(
        `Paymaster ${method}: ${json.error.message} (code: ${json.error.code})${detail}`
      );
    }
    return json.result as T;
  }
}
