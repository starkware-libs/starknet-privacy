/**
 * Proof provider that calls a remote proving service (JSON-RPC starknet_proveTransaction).
 * Builds the invoke tx payload like a regular invoke: wrap (entrypoint, calldata) in Call[]
 * and compile to __execute__ calldata, then buildTransaction.
 */

import type { BlockIdentifier, constants, ProviderInterface } from "starknet";
import { transaction, TransactionType } from "starknet";
import type { Proof, ProofInvocation, ProofProviderInterface } from "../interfaces.js";
import { toHex } from "../utils/convert.js";
import { getDefaultProofDetails } from "./proof-invocation-factory.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, ProvingService } from "./proving-service.js";

/** Provider with channel.buildTransaction (e.g. RpcProvider). */
export type ProvingServiceProvider = ProviderInterface & {
  channel: {
    buildTransaction(invocation: unknown, versionType?: "fee" | "transaction"): object;
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
    const details = this.getDefaultDetails();
    const calldata = invocation.calldata as string[];

    const executeCalldata = transaction.getExecuteCalldata(
      [{ contractAddress: invocation.contractAddress, entrypoint: "execute_view", calldata }],
      "1" // cairoVersion
    );
    const transactionPayload = this.provider.channel.buildTransaction({
      type: TransactionType.INVOKE,
      contractAddress: invocation.contractAddress, // → sender_address in built tx (pool)
      calldata: executeCalldata,
      signature: invocation.signature ?? [],
      nonce: details.nonce ?? 0n,
      resourceBounds: details.resourceBounds ?? {},
      tip: details.tip ?? 0n,
      paymasterData: details.paymasterData ?? [],
      accountDeploymentData: details.accountDeploymentData ?? [],
      nonceDataAvailabilityMode: details.nonceDataAvailabilityMode ?? "L1",
      feeDataAvailabilityMode: details.feeDataAvailabilityMode ?? "L1",
      version: details.version,
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
