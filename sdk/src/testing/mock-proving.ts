/**
 * Call-based proving provider for testing
 *
 * This provider simulates proof generation by making a call to the contract
 * to execute the invocation and capture the output.
 */

import type { constants, ETransactionVersion3, ProviderInterface } from "starknet";
import { EDAMode, encode, hash, num, stark } from "starknet";
import type {
  Proof,
  ProofInvocation,
  ProofInvocationPayloadDetails,
} from "../interfaces.js";
import { AbstractProofProvider } from "../internal/abstract-proof-provider.js";
import { buildProofFacts } from "../utils/proof-facts.js";
import { toBigInt } from "../utils/convert.js";

/** VALIDATED constant - 'VALID' encoded as short string felt252 */
const VALIDATED = encode.utf8ToBigInt("VALID");

/**
 * A proving provider that uses Starknet calls to simulate proof generation.
 * This is useful for testing where we want to execute the contract logic
 * without actually generating zero-knowledge proofs.
 */
export class CallMockProofProvider extends AbstractProofProvider {
  constructor(
    private readonly provider: ProviderInterface,
    private readonly chainId: constants.StarknetChainId
  ) {
    super();
  }

  protected getChainId(): constants.StarknetChainId {
    return this.chainId;
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    // Validate signature similar to how __execute__ does in the contract.
    // execute_view skips this since view functions don't have tx_info.
    await this.validateSignature(invocation);

    const result = await this.provider.callContract({
      contractAddress: invocation.contractAddress,
      entrypoint: "execute_view",
      calldata: invocation.calldata!,
    });

    // Build proof facts for on-chain validation when provider supports getBlock (e.g. e2e with RpcProvider).
    // Blockifier requires base_block_number to be at least STORED_BLOCK_HASH_BUFFER (10) blocks behind current.
    let proofFacts: string[] = [];
    const providerWithBlock = this.provider as ProviderInterface & {
      getBlock?(id: unknown): Promise<{ block_number: number; block_hash?: string }>;
    };
    if (typeof providerWithBlock.getBlock === "function") {
      const latestBlock = await providerWithBlock.getBlock("latest");
      const currentBlockNumber = BigInt(latestBlock.block_number);
      const baseBlockNumber = currentBlockNumber > 10n ? currentBlockNumber - 10n : 1n;
      const baseBlock = await providerWithBlock.getBlock(Number(baseBlockNumber));
      const chainId = this.chainId;
      proofFacts = buildProofFacts(
        invocation.contractAddress,
        result,
        baseBlockNumber,
        baseBlock.block_hash ?? "0x0",
        chainId
      );
    }

    // execute_view returns Span<ServerAction> which is serialized with its length prefix.
    // apply_actions also expects Span<ServerAction> with the length prefix, so we pass it through as-is.
    return { output: result, data: undefined!, proofFacts };
  }

  /**
   * Validates the signature by calling is_valid_signature on the user's account.
   * The hash must match ProofInvocationFactory: sender is the pool, compiledCalldata is the
   * pool's __execute__ calldata (user, viewingKey, actions). The user signs that hash.
   */
  private async validateSignature(invocation: ProofInvocation): Promise<void> {
    const signatureArray = invocation.signature ? stark.formatSignature(invocation.signature) : [];
    if (signatureArray.length === 0) {
      // No signature to validate (e.g., mock invocation factory)
      return;
    }

    const calldata = invocation.calldata as string[];
    const userAddress = num.toHex(calldata[0]);

    // Use the same hash as ProofInvocationFactory: pool is sender, calldata is __execute__ calldata
    const details = this.getDefaultDetails();
    const inv = invocation as ProofInvocation & Partial<ProofInvocationPayloadDetails>;
    const nonceDAM = inv.nonceDataAvailabilityMode ?? details.nonceDataAvailabilityMode!;
    const feeDAM = inv.feeDataAvailabilityMode ?? details.feeDataAvailabilityMode!;
    const txHash = hash.calculateInvokeTransactionHash({
      senderAddress: invocation.contractAddress,
      compiledCalldata: calldata,
      version: (details.version ?? "0x3") as ETransactionVersion3,
      chainId: this.chainId,
      nonce: inv.nonce ?? details.nonce!,
      accountDeploymentData: inv.accountDeploymentData ?? details.accountDeploymentData!,
      nonceDataAvailabilityMode: stark.intDAM(nonceDAM as "L1" | "L2"),
      feeDataAvailabilityMode: stark.intDAM(feeDAM as "L1" | "L2"),
      resourceBounds: inv.resourceBounds ?? details.resourceBounds!,
      tip: inv.tip ?? details.tip!,
      paymasterData: inv.paymasterData ?? details.paymasterData!,
    });

    // Call is_valid_signature on user's account
    // Calldata format: [hash, signature_length, ...signature_elements]
    const isValidCalldata = [txHash, num.toHex(signatureArray.length), ...signatureArray];

    const result = await this.provider.callContract({
      contractAddress: userAddress,
      entrypoint: "is_valid_signature",
      calldata: isValidCalldata,
    });

    // Check result equals VALIDATED ('VALID' as felt252)
    if (toBigInt(result[0]) !== VALIDATED) {
      throw new Error(`Signature validation failed: expected ${VALIDATED}, got ${result[0]}`);
    }
  }
}
