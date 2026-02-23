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
 * Block reference used when proving a transaction.
 * - `"latest"`: Prove against the latest accepted block (default). The wallet may need to wait for block finality (e.g. 10 blocks) before submitting.
 * - `"latest-verifiable"`: Resolve to a block that is already verifiable (current - blocksBack). Use when you want to avoid the wait.
 * - `{ blocksBack: number }`: Prove against (current block - blocksBack). Same as latest-verifiable with a custom offset.
 * - Explicit `BlockIdentifier`: Block tag ("pending"), block number, or block hash for maximum reliability (deterministic replay).
 */
export type ProvingBlockId = BlockIdentifier | "latest-verifiable" | { blocksBack: number };

/** Default number of blocks back for "latest-verifiable". Matches typical finality buffer (e.g. STORED_BLOCK_HASH_BUFFER). */
export const DEFAULT_BLOCKS_BACK_VERIFIABLE = 10;

/** Options for ProvingServiceProofProvider. */
export type ProvingServiceProofProviderOptions = {
  /** Request timeout in ms. Proofs take ~1–2 min; default 600_000 (10 min). */
  requestTimeoutMs?: number;
  /**
   * Block reference for proving. Default `"latest"`.
   * Use `"latest-verifiable"` or `{ blocksBack: N }` to prove against an already-verifiable block and avoid waiting for finality.
   */
  blockIdentifier?: ProvingBlockId;
  /** When blockIdentifier is "latest-verifiable", number of blocks behind current. Default 10. */
  blocksBackForLatestVerifiable?: number;
};

/** Minimal provider shape for block resolution. Used by type guard below. */
export type GetBlockProvider = {
  getBlock(id: BlockIdentifier): Promise<{ block_number: number; block_hash?: string }>;
};

/** Type guard: true if the provider exposes getBlock (e.g. RpcProvider). */
export function hasGetBlock(p: unknown): p is GetBlockProvider {
  return typeof (p as { getBlock?: unknown }).getBlock === "function";
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
  private readonly blockIdentifier: ProvingBlockId;
  private readonly blocksBackForLatestVerifiable: number;

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
    this.blockIdentifier = options.blockIdentifier ?? "latest";
    this.blocksBackForLatestVerifiable =
      options.blocksBackForLatestVerifiable ?? DEFAULT_BLOCKS_BACK_VERIFIABLE;
  }

  getDefaultDetails() {
    return getDefaultProofDetails(this.chainId);
  }

  /** Resolves ProvingBlockId to a BlockIdentifier for the proving service. */
  private async resolveBlockId(): Promise<BlockIdentifier> {
    const id = this.blockIdentifier;
    const isRelative =
      id === "latest-verifiable" || (typeof id === "object" && id !== null && "blocksBack" in id);
    if (!isRelative) {
      return id as BlockIdentifier;
    }
    if (!hasGetBlock(this.provider)) {
      throw new Error(
        'ProvingServiceProofProvider: blockIdentifier "latest-verifiable" or { blocksBack } requires a provider with getBlock (e.g. RpcProvider).'
      );
    }
    const latestBlock = await this.provider.getBlock("latest");
    const currentBlockNumber = BigInt(latestBlock.block_number);
    const blocksBack =
      typeof id === "object" && id !== null && "blocksBack" in id
        ? id.blocksBack
        : this.blocksBackForLatestVerifiable;
    const targetBlockNumber =
      currentBlockNumber > BigInt(blocksBack) ? currentBlockNumber - BigInt(blocksBack) : 1n;
    return Number(targetBlockNumber);
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
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

    const blockId = await this.resolveBlockId();
    const result = await this.provingService.proveTransaction(blockId, transactionPayload);

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
