/**
 * Call-based proving provider for testing
 *
 * This provider simulates proof generation by making a call to the contract
 * to execute the invocation and capture the output.
 */

import type { BlockIdentifier, constants, ETransactionVersion3, ProviderInterface } from "starknet";
import { EDAMode, encode, hash, num, stark } from "starknet";
import type { Proof, ProofInvocation, ProofProviderInterface } from "../interfaces.js";
import { getDefaultProofDetails, extractExecuteViewCalldata } from "./proof-invocation-factory.js";
import { ProvingServiceError } from "./proving-service.js";
import { buildProofFacts, buildMessagePayload } from "../utils/proof-facts.js";
import { toBigInt } from "../utils/convert.js";

/** VALIDATED constant - 'VALID' encoded as short string felt252 */
const VALIDATED = encode.utf8ToBigInt("VALID");

/**
 * A proving provider that uses Starknet calls to simulate proof generation.
 * This is useful for testing where we want to execute the contract logic
 * without actually generating zero-knowledge proofs.
 */
export class CallMockProofProvider implements ProofProviderInterface {
  constructor(
    protected readonly provider: ProviderInterface,
    protected readonly chainId: constants.StarknetChainId,
    private readonly options?: { validateSignature?: boolean }
  ) {}

  async getDefaultDetails() {
    return getDefaultProofDetails(this.chainId);
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: BlockIdentifier): Promise<Proof> {
    // Validate signature similar to how __execute__ does in the contract.
    // compile_actions skips this since view functions don't have tx_info.
    if (this.options?.validateSignature !== false) {
      await this.validateSignature(invocation);
    }

    // __execute__ calldata is Array<Call> with one Call targeting compile_actions.
    // Layout: [1, to, selector, inner_len, ...inner_calldata]
    const executeViewCalldata = extractExecuteViewCalldata(invocation.calldata as string[]);

    const result = await this.provider.callContract(
      {
        contractAddress: invocation.sender_address,
        entrypoint: "compile_actions",
        calldata: executeViewCalldata,
      },
      blockIdentifier
    );

    const poolClassHash = await this.provider.getClassHashAt(
      invocation.sender_address,
      blockIdentifier
    );

    // Build proof facts for on-chain validation.
    // When the caller provides an explicit blockIdentifier, use it as the base block directly
    // (the caller is responsible for picking a block old enough for the blockifier to accept).
    // When falling back to "latest", subtract STORED_BLOCK_HASH_BUFFER so the blockifier
    // can verify the block hash from state.
    let baseBlockNumber: bigint;
    if (blockIdentifier != null) {
      const block = await this.provider.getBlock(blockIdentifier);
      baseBlockNumber = BigInt(block.block_number);
    } else {
      const latestBlock = await this.provider.getBlock("latest");
      const currentBlockNumber = BigInt(latestBlock.block_number);
      const blocksBack = 10n;
      baseBlockNumber = currentBlockNumber > blocksBack ? currentBlockNumber - blocksBack : 1n;
    }
    const baseBlock = await this.provider.getBlock(Number(baseBlockNumber));
    const proofFacts = buildProofFacts(
      invocation.sender_address,
      poolClassHash,
      result,
      baseBlockNumber,
      baseBlock.block_hash ?? "0x0",
      this.chainId
    );

    // Return the full L2-to-L1 message payload: [class_hash, ...serialized_actions].
    // This matches the real proving service behavior. The consumer must strip the
    // class_hash prefix before passing to apply_actions.
    const messagePayload = buildMessagePayload(poolClassHash, result);
    return { output: messagePayload, data: undefined!, proofFacts };
  }

  /**
   * Validates the signature by calling is_valid_signature on the user's account.
   * This mirrors what the contract's __execute__ does after compile_actions.
   */
  private async validateSignature(invocation: ProofInvocation): Promise<void> {
    const signatureArray = invocation.signature ? stark.formatSignature(invocation.signature) : [];
    if (signatureArray.length === 0) {
      // No signature to validate (e.g., mock invocation factory)
      return;
    }

    // First arg of compile_actions calldata is user_addr.
    const calldata = invocation.calldata as string[];
    const innerCalldata = extractExecuteViewCalldata(calldata);
    const userAddress = num.toHex(innerCalldata[0]);

    // Compute transaction hash using the same parameters as the signer.
    // invocation.calldata is already the __execute__ calldata (Array<Call> wrapping
    // compile_actions), so use it directly — no re-wrapping via getExecuteCalldata.
    const details = await this.getDefaultDetails();
    const txHash = hash.calculateInvokeTransactionHash({
      senderAddress: num.toHex(invocation.sender_address),
      version: details.version as ETransactionVersion3,
      compiledCalldata: calldata,
      chainId: this.chainId,
      nonce: details.nonce!,
      accountDeploymentData: details.accountDeploymentData!,
      nonceDataAvailabilityMode: EDAMode[details.nonceDataAvailabilityMode!],
      feeDataAvailabilityMode: EDAMode[details.feeDataAvailabilityMode!],
      resourceBounds: details.resourceBounds!,
      tip: details.tip!,
      paymasterData: details.paymasterData!,
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
      throw new ProvingServiceError(
        55,
        "Account validation failed",
        `Signature validation failed: expected ${VALIDATED}, got ${result[0]}`
      );
    }
  }
}
