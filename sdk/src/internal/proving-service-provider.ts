/**
 * Proof provider that calls a remote proving service (JSON-RPC starknet_proveTransaction).
 * Uses provider.channel.buildTransaction with details taken from the invocation.
 */

import type { BlockIdentifier, constants, ProviderInterface } from "starknet";
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
  /**
   * Block reference for proving. Sent as block_id: "latest" | { block_number } | { block_hash }.
   * Default `"latest"`.
   */
  // TODO: Change default to latest-verifiable.
  blockIdentifier?: ProvingBlockId;
};

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
