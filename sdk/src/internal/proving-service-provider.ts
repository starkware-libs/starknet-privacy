/**
 * Proof provider that calls a remote proving service (JSON-RPC starknet_proveTransaction).
 * Uses provider.channel.buildTransaction with details taken from the invocation.
 */

import type { BlockIdentifier, BigNumberish, constants, ProviderInterface, Signature } from "starknet";
import type { INVOKE_TXN_V3 } from "./proving-service.js";
import type { Proof, ProofInvocation, ProofProviderInterface } from "../interfaces.js";
import { toHex } from "../utils/convert.js";
import { getDefaultProofDetails } from "./proof-invocation-factory.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, ProvingService } from "./proving-service.js";

/** Provider with channel.buildTransaction (e.g. RpcProvider). */
export type ProvingServiceProvider = ProviderInterface & {
  channel: {
    buildTransaction(
      invocation: ProofInvocation,
      versionType?: "fee" | "transaction"
    ): INVOKE_TXN_V3;
  };
};

/**
 * Block reference for proving. Passed as block_id to the proving service.
 * Server currently supports: "latest" | { block_number: N } | { block_hash: "0x..." }.
 */
// TODO: Add latest-verifiable to the proving service.
export type ProvingBlockId = BlockIdentifier;

/** Options for ProvingServiceProofProvider. */
export type ProvingServiceProofProviderOptions = {
  /** Request timeout in ms. */
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
export class ProvingServiceProofProvider implements ProofProviderInterface {
  private readonly provingService: ProvingService;

  constructor(
    provingServiceUrl: string,
    private readonly provider: ProvingServiceProvider,
    private readonly chainId: constants.StarknetChainId,
    options: ProvingServiceProofProviderOptions = {}
  ) {
    this.provingService = new ProvingService({
      baseUrl: provingServiceUrl,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  getDefaultDetails() {
    return getDefaultProofDetails(this.chainId);
  }

  async prove(invocation: ProofInvocation, blockId?: BlockIdentifier): Promise<Proof> {
    // invocation.calldata is already the full __execute__ calldata
    // (Array<Call> wrapping execute_view), compiled by ProofInvocationFactory.
    const transactionPayload = this.provider.channel.buildTransaction({
      ...invocation,
      calldata: invocation.calldata as string[],
    });

    const result = await this.provingService.proveTransaction(
      blockId ?? "latest",
      transactionPayload
    );

    // Server actions for execute_actions: from L2-to-L1 message payload (from_address = pool)
    // TODO: Generalize this to support other projects.
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
