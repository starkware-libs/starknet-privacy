/**
 * Proof provider that calls a remote proving service (JSON-RPC starknet_proveTransaction).
 * Builds the invoke tx payload like a regular invoke: wrap (entrypoint, calldata) in Call[]
 * and compile to __execute__ calldata, then buildTransaction.
 */

import type { Account, constants, ProviderInterface } from "starknet";
import { transaction, TransactionType } from "starknet";
import type { Proof, ProofInvocation } from "../interfaces.js";
import { toHex } from "../utils/convert.js";
import { AbstractProofProvider } from "./abstract-proof-provider.js";
import { ProvingService } from "./proving-service.js";

/** Provider with channel.buildTransaction (e.g. RpcProvider). */
export type ProvingServiceProvider = ProviderInterface & {
  channel: {
    buildTransaction(invocation: unknown, versionType?: "fee" | "transaction"): object;
  };
};

/** Default request timeout: 600s (proofs take ~1–2 min; guide recommends --max-time 600). */
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** Options for ProvingServiceProofProvider. */
export type ProvingServiceProofProviderOptions = {
  /** Request timeout in ms. Proofs take ~1–2 min; default 600_000 (10 min). */
  requestTimeoutMs?: number;
};

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
    private readonly provider: ProvingServiceProvider,
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
