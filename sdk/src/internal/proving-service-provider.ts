/**
 * Proof provider that calls a remote proving service (JSON-RPC starknet_proveTransaction).
 */

import type { constants } from "starknet";
import type {
  Proof,
  ProvingBlockId,
  ProofInvocation,
  ProofProviderInterface,
} from "../interfaces.js";
import { toHex } from "../utils/convert.js";
import { getDefaultProofDetails } from "./proof-invocation-factory.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, ProvingService } from "./proving-service.js";

/** Options for ProvingServiceProofProvider. */
export type ProvingServiceProofProviderOptions = {
  /** Request timeout in ms. */
  requestTimeoutMs?: number;
  /**
   * Default block identifier for proving. Sent as block_id: "latest" | { block_number } | { block_hash }.
   * Used when `blockIdentifier` is not provided in `prove()`.
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
  private readonly blockIdentifier: ProvingBlockId;

  constructor(
    provingServiceUrl: string,
    private readonly chainId: constants.StarknetChainId,
    options: ProvingServiceProofProviderOptions = {}
  ) {
    this.provingService = new ProvingService({
      baseUrl: provingServiceUrl,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    this.blockIdentifier = options.blockIdentifier ?? "latest";
  }

  getDefaultDetails() {
    return getDefaultProofDetails(this.chainId);
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: ProvingBlockId): Promise<Proof> {
    const blockId = blockIdentifier ?? this.blockIdentifier;

    const result = await this.provingService.proveTransaction(blockId, invocation);

    // Server actions for execute_actions: from L2-to-L1 message payload (from_address = pool)
    // TODO: Generalize this to support other projects.
    const poolAddressHex = toHex(invocation.sender_address);
    const poolMessage = result.l2_to_l1_messages?.find(
      (m) => m.from_address?.toLowerCase() === poolAddressHex.toLowerCase()
    );
    // Payload format: [class_hash, ...serialized_server_actions].
    // Strip the class_hash prefix — apply_actions expects only Span<ServerAction>.
    const output = poolMessage?.payload?.slice(1) ?? [];

    const proofFacts = result.proof_facts ?? [];

    return {
      data: result.proof,
      output,
      proofFacts,
    };
  }
}
