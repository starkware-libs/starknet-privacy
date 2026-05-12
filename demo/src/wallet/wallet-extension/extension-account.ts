// `ExtensionAccount` — drop-in replacement for starknet.js's `Account` that
// signs via a connected wallet (Argent X) and submits via a hardcoded relayer
// (Charlie). The wallet only ever signs; the broadcast is on our side.
//
// The trick: `ExtensionAccount` extends `Account` so any consumer that holds
// an `Account` reference (the SDK's createPrivateTransfers, the OTC service,
// the audit screen, every modal in this wallet) keeps working unchanged.
// We override `execute()` — the one Account method consumers actually call —
// to wrap the calls in a SNIP-9 OutsideExecution, get the wallet signature,
// and submit `account.execute_from_outside_v2(...)` via Charlie.

import {
  Account,
  type Call,
  type InvokeFunctionResponse,
  type RpcProvider,
  type UniversalDetails,
} from "starknet";
import {
  buildOutsideExecutionTypedData,
  newOutsideExecution,
  serializeOutsideExecution,
} from "./outside-execution.ts";
import type { ConnectedWallet } from "./types.ts";

export class ExtensionAccount extends Account {
  constructor(
    provider: RpcProvider,
    private readonly userAddress: string,
    private readonly wallet: ConnectedWallet,
    private readonly relayer: Account,
    /** Scalar used by the SDK for proof signing. Distinct from the wallet's
     *  master key — derived from a wallet typed-data signature so we can
     *  reproduce it without ever holding the master key. The pool registers
     *  `derive_pub(proofPrivateKey)` under the user's wallet address; all
     *  future proofs sign with this scalar and verify against that pubkey. */
    proofPrivateKey: bigint
  ) {
    // The SDK calls `account.signer.signTransaction(...)` deep inside its
    // proof-invocation flow (see proof-invocation-factory.js). We give the
    // base Account a real Stark-curve Signer constructed from the derived
    // proof key so those calls produce a valid signature without ever
    // touching the wallet's master key.
    super({
      provider,
      address: userAddress,
      signer: "0x" + proofPrivateKey.toString(16),
      cairoVersion: "1",
    });
  }

  /**
   * Sign-only override. Builds a SNIP-9 OutsideExecution wrapping the
   * caller's `calls`, asks the wallet to sign the typed-data hash, then
   * submits `userAccount.execute_from_outside_v2(...)` via the relayer.
   *
   * Returns the same `InvokeFunctionResponse` shape (`{ transaction_hash }`)
   * starknet.js's normal `execute()` would return, so all upstream code
   * (`waitForTransaction(...)`, the timeline display, the modal success view)
   * works unchanged.
   */
  async execute(
    transactions: Call | Call[],
    transactionsDetail?: UniversalDetails
  ): Promise<InvokeFunctionResponse>;
  async execute(transactions: Call | Call[]): Promise<InvokeFunctionResponse>;
  async execute(
    transactions: Call | Call[],
    transactionsDetail?: UniversalDetails
  ): Promise<InvokeFunctionResponse> {
    const calls = Array.isArray(transactions) ? transactions : [transactions];

    const outsideExec = newOutsideExecution(calls);
    const typedData = buildOutsideExecutionTypedData(outsideExec, this.wallet.chainId);

    const sigResult = await this.wallet.wallet.request({
      type: "wallet_signTypedData",
      params: typedData,
    });
    const signature = normalizeSignature(sigResult);
    if (signature.length < 2) {
      throw new Error("Wallet signature missing (r, s) components");
    }

    const calldata = serializeOutsideExecution(outsideExec, signature);

    // The relayer submits `userAccount.execute_from_outside_v2(...)` on the
    // user's own account contract. The user's account verifies the signature
    // (it's its own owner key), runs the inner calls, and the relayer pays
    // the gas. From the chain's perspective `tx.sender == relayer`.
    return this.relayer.execute(
      [
        {
          contractAddress: this.userAddress,
          entrypoint: "execute_from_outside_v2",
          calldata,
        },
      ],
      transactionsDetail
    );
  }
}

function normalizeSignature(result: unknown): string[] {
  if (Array.isArray(result)) {
    return result.map((value) =>
      typeof value === "string" ? value : "0x" + BigInt(value as number | bigint).toString(16)
    );
  }
  if (typeof result === "object" && result !== null) {
    const obj = result as { r?: string; s?: string; signature?: string[] };
    if (Array.isArray(obj.signature)) return obj.signature;
    if (typeof obj.r === "string" && typeof obj.s === "string") return [obj.r, obj.s];
  }
  return [];
}
