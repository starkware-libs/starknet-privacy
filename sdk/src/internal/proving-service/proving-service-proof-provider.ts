/**
 * Proof provider that uses the Starknet Proving Service (JSON-RPC) to generate proofs.
 * Sends the signed __execute__ invocation to the service and uses the L2->L1 message
 * payload (serialized ServerAction span) as the execute_actions calldata.
 */

import type { constants } from "starknet";
import { ETransactionVersion, num, stark, transaction } from "starknet";
import type {
  Proof,
  ProofProviderInterface,
  ProofInvocation,
  ProofInvocationFactoryDetails,
} from "../../interfaces.js";
import type { BlockId, RpcInvokeTransactionV3 } from "./types.js";
import { ProvingServiceClient } from "./client.js";
import type { ProvingServiceConfig } from "./client.js";

/** Convert proof (u32[]) from the service to Uint8Array (4 bytes per u32, big-endian). */
function proofToBytes(proof: number[]): Uint8Array {
  const buf = new Uint8Array(proof.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < proof.length; i++) view.setUint32(i * 4, proof[i] >>> 0, false);
  return buf;
}

/**
 * Configuration for the proving service proof provider.
 */
export interface ProvingServiceProofProviderConfig extends ProvingServiceConfig {
  /** Chain ID for signing (e.g. SN_SEPOLIA). */
  chainId: constants.StarknetChainId;
  /**
   * Block to prove against. Use "latest" or a specific block number/hash.
   * "pending" is not supported by the proving service.
   */
  blockId?: BlockId;
}

/**
 * Proof provider that calls the remote Proving Service to generate proofs.
 * The service executes the __execute__ transaction and returns proof, proof_facts,
 * and l2_to_l1_messages. The server actions are extracted from the L2->L1 message
 * payload (contract sends serialized Span<ServerAction> to address 0).
 */
export class ProvingServiceProofProvider implements ProofProviderInterface {
  private readonly client: ProvingServiceClient;
  private readonly chainId: constants.StarknetChainId;
  private readonly blockId: BlockId;

  constructor(private readonly config: ProvingServiceProofProviderConfig) {
    this.client = new ProvingServiceClient(config);
    this.chainId = config.chainId;
    this.blockId = config.blockId ?? "latest";
  }

  getDefaultDetails(): ProofInvocationFactoryDetails {
    return {
      versions: [ETransactionVersion.V3],
      nonce: 0n,
      skipValidate: true,
      resourceBounds: {
        l1_gas: { max_amount: 0n, max_price_per_unit: 0n },
        l2_gas: { max_amount: 0n, max_price_per_unit: 0n },
        l1_data_gas: { max_amount: 0n, max_price_per_unit: 0n },
      },
      tip: 0n,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      version: ETransactionVersion.V3,
      chainId: this.chainId,
    };
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    const details = this.getDefaultDetails();
    const tx = this.buildRpcTransaction(invocation, details);
    const result = await this.client.proveTransaction(this.blockId, tx);

    const serverActionsPayload = this.extractServerActionsPayload(
      result.l2_to_l1_messages,
      invocation.contractAddress
    );
    if (!serverActionsPayload) {
      throw new Error(
        "Proving service did not return L2->L1 message with server actions (from_address=pool, to_address=0x0)"
      );
    }

    return {
      output: serverActionsPayload,
      outputHash: "0x0",
      data: proofToBytes(result.proof),
    };
  }

  /**
   * Build Invoke V3 RPC transaction from the signed invocation.
   */
  private buildRpcTransaction(
    invocation: ProofInvocation,
    details: ProofInvocationFactoryDetails
  ): RpcInvokeTransactionV3 {
    const calldata = invocation.calldata as string[];
    const userAddress = num.toHex(calldata[0]);
    const executeCalldata = transaction.getExecuteCalldata(
      [
        {
          contractAddress: invocation.contractAddress,
          entrypoint: "__execute__",
          calldata,
        },
      ],
      "1"
    );

    const resourceBounds = details.resourceBounds!;
    return {
      type: "INVOKE",
      version: "0x3",
      sender_address: userAddress,
      calldata: executeCalldata,
      signature: invocation.signature ? stark.formatSignature(invocation.signature) : [],
      nonce: num.toHex(details.nonce ?? 0n),
      resource_bounds: {
        l1_gas: {
          max_amount: num.toHex(resourceBounds.l1_gas.max_amount),
          max_price_per_unit: num.toHex(resourceBounds.l1_gas.max_price_per_unit),
        },
        l2_gas: {
          max_amount: num.toHex(resourceBounds.l2_gas.max_amount),
          max_price_per_unit: num.toHex(resourceBounds.l2_gas.max_price_per_unit),
        },
        l1_data_gas: {
          max_amount: num.toHex(resourceBounds.l1_data_gas.max_amount),
          max_price_per_unit: num.toHex(resourceBounds.l1_data_gas.max_price_per_unit),
        },
      },
      tip: num.toHex(details.tip ?? 0n),
      paymaster_data: (details.paymasterData ?? []).map((x) => num.toHex(x)),
      account_deployment_data: (details.accountDeploymentData ?? []).map((x) => num.toHex(x)),
      nonce_data_availability_mode: details.nonceDataAvailabilityMode ?? "L1",
      fee_data_availability_mode: details.feeDataAvailabilityMode ?? "L1",
    };
  }

  /**
   * Find the L2->L1 message that carries the server actions: from_address = pool, to_address = 0.
   */
  private extractServerActionsPayload(
    messages: Array<{ from_address: string; to_address: string; payload: string[] }>,
    poolAddress: string
  ): string[] | null {
    const poolLower = poolAddress.toLowerCase();
    for (const msg of messages) {
      const toZero = msg.to_address === "0x0" || BigInt(msg.to_address) === 0n;
      if (msg.from_address.toLowerCase() === poolLower && toZero) {
        return msg.payload;
      }
    }
    return null;
  }
}
