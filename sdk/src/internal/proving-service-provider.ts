/**
 * Proof provider that calls a remote proving service (JSON-RPC starknet_proveTransaction).
 * Uses Invoke V3 transaction format; fetches nonce from the chain.
 */

import type { Account, BigNumberish, constants, ProviderInterface, Signature } from "starknet";
import { num, stark } from "starknet";
import type { Proof, ProofInvocationWithPayload } from "../interfaces.js";
import { toHex } from "../utils/convert.js";
import { AbstractProofProvider } from "./abstract-proof-provider.js";
import { ProvingService } from "./proving-service.js";

/** Default request timeout: 600s (proofs take ~1–2 min; guide recommends --max-time 600). */
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** Options for ProvingServiceProofProvider. */
export type ProvingServiceProofProviderOptions = {
  /** Request timeout in ms. Proofs take ~1–2 min; default 600_000 (10 min). */
  requestTimeoutMs?: number;
};

/** Input for building a transaction payload for the proving service. */
export type TransactionPayloadInput = {
  contractAddress: string | bigint;
  calldata: string[];
  signature?: Signature;
  nonce: bigint | string | number;
  resourceBounds: {
    l1_gas: { max_amount: bigint | string | number; max_price_per_unit: bigint | string | number };
    l2_gas: { max_amount: bigint | string | number; max_price_per_unit: bigint | string | number };
    l1_data_gas: { max_amount: bigint | string | number; max_price_per_unit: bigint | string | number };
  };
  tip: bigint | string | number;
  paymasterData?: BigNumberish[];
  accountDeploymentData?: BigNumberish[];
  nonceDataAvailabilityMode?: string;
  feeDataAvailabilityMode?: string;
};

/**
 * Build the transaction payload for starknet_proveTransaction RPC call.
 * Exported so tests can validate the exact format sent to the proving service.
 */
export function buildTransactionPayload(inv: TransactionPayloadInput) {
  return {
    type: "INVOKE" as const,
    version: "0x3" as const,
    sender_address: toHex(inv.contractAddress),
    calldata: inv.calldata.map((x) =>
      x.startsWith("0x") ? x : `0x${BigInt(x).toString(16)}`
    ),
    signature: stark
      .formatSignature(inv.signature ?? [])
      .map((s: string) => (typeof s === "string" && s.startsWith("0x") ? s : num.toHex(s))),
    nonce: num.toHex(inv.nonce),
    resource_bounds: {
      l1_gas: {
        max_amount: num.toHex(inv.resourceBounds.l1_gas.max_amount),
        max_price_per_unit: num.toHex(inv.resourceBounds.l1_gas.max_price_per_unit),
      },
      l2_gas: {
        max_amount: num.toHex(inv.resourceBounds.l2_gas.max_amount),
        max_price_per_unit: num.toHex(inv.resourceBounds.l2_gas.max_price_per_unit),
      },
      l1_data_gas: {
        max_amount: num.toHex(inv.resourceBounds.l1_data_gas.max_amount),
        max_price_per_unit: num.toHex(inv.resourceBounds.l1_data_gas.max_price_per_unit),
      },
    },
    tip: num.toHex(inv.tip),
    paymaster_data: (inv.paymasterData ?? []).map((x) => num.toHex(x)),
    account_deployment_data: (inv.accountDeploymentData ?? []).map((x) => num.toHex(x)),
    nonce_data_availability_mode: inv.nonceDataAvailabilityMode ?? "L1",
    fee_data_availability_mode: inv.feeDataAvailabilityMode ?? "L1",
  };
}

/**
 * Proof provider that sends the invocation to a remote proving service (JSON-RPC)
 * and returns the STARK proof. Server actions for execute_actions come from the
 * L2-to-L1 message payload (from_address = pool).
 *
 * @param provingServiceUrl - Full base URL of the proving service (e.g. https://prover.example.com:3000)
 */
export class ProvingServiceProofProvider extends AbstractProofProvider {
  private readonly provingService: ProvingService;

  constructor(
    provingServiceUrl: string,
    private readonly provider: ProviderInterface,
    private readonly chainId: constants.StarknetChainId,
    private readonly account: Account,
    options: ProvingServiceProofProviderOptions = {}
  ) {
    super();
    this.provingService = new ProvingService({
      baseUrl: provingServiceUrl,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  protected getChainId(): constants.StarknetChainId {
    return this.chainId;
  }

  async prove(invocation: ProofInvocationWithPayload): Promise<Proof> {
    const transactionPayload = buildTransactionPayload({
      contractAddress: invocation.contractAddress,
      calldata: invocation.calldata as string[],
      signature: invocation.signature,
      nonce: invocation.nonce,
      resourceBounds: invocation.resourceBounds,
      tip: invocation.tip,
      paymasterData: invocation.paymasterData,
      accountDeploymentData: invocation.accountDeploymentData,
      nonceDataAvailabilityMode: invocation.nonceDataAvailabilityMode,
      feeDataAvailabilityMode: invocation.feeDataAvailabilityMode,
    });

    const result = await this.provingService.proveTransaction("latest", transactionPayload);

    // Server actions for execute_actions: from L2-to-L1 message payload (no execute_view call)
    const poolAddressHex = toHex(invocation.contractAddress);
    const poolMessage = result.l2_to_l1_messages?.find(
      (m) => m.from_address?.toLowerCase() === poolAddressHex.toLowerCase()
    );
    const output = poolMessage?.payload ?? [];

    const proofFacts = result.proof_facts ?? [];

    return {
      data: result.proof,
      output,
      proofFacts,
    };
  }
}
