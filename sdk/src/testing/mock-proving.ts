/**
 * Call-based proving provider for testing
 *
 * This provider simulates proof generation by making a call to the contract
 * to execute the invocation and capture the output.
 */

import type { constants, ETransactionVersion3, ProviderInterface } from "starknet";
import { EDAMode, encode, hash, num, stark } from "starknet";
import type { Proof, ProofInvocation, ProofProviderInterface } from "../interfaces.js";
import { getDefaultProofDetails } from "../internal/proof-invocation-factory.js";
import { buildProofFacts, buildMessagePayload } from "../utils/proof-facts.js";
import { toBigInt } from "../utils/convert.js";
import { extractExecuteViewCalldata } from "../internal/proof-invocation-factory.js";

/** VALIDATED constant - 'VALID' encoded as short string felt252 */
const VALIDATED = encode.utf8ToBigInt("VALID");

/**
 * A proving provider that uses Starknet calls to simulate proof generation.
 * This is useful for testing where we want to execute the contract logic
 * without actually generating zero-knowledge proofs.
 */
export class CallMockProofProvider implements ProofProviderInterface {
  constructor(
    private readonly provider: ProviderInterface,
    private readonly chainId: constants.StarknetChainId
  ) {}

  getDefaultDetails() {
    return getDefaultProofDetails(this.chainId);
  }

  async prove(invocation: ProofInvocation): Promise<Proof> {
    // Validate signature similar to how __execute__ does in the contract.
    // compile_actions skips this since view functions don't have tx_info.
    await this.validateSignature(invocation);

    // __execute__ calldata is Array<Call> with one Call targeting compile_actions.
    // Layout: [1, to, selector, inner_len, ...inner_calldata]
    const executeViewCalldata = extractExecuteViewCalldata(invocation.calldata as string[]);

    const result = await this.provider.callContract({
      contractAddress: invocation.sender_address,
      entrypoint: "compile_actions",
      calldata: executeViewCalldata,
    });

    const poolClassHash = await this.provider.getClassHashAt(invocation.sender_address);

    // Build proof facts for on-chain validation when provider supports getBlock (e.g. e2e with RpcProvider).
    // Blockifier requires base_block_number to be at least STORED_BLOCK_HASH_BUFFER blocks behind current.
    // TODO: Use latest-verifiable.
    let proofFacts: string[] = [];
    const latestBlock = await this.provider.getBlock("latest");
    const currentBlockNumber = BigInt(latestBlock.block_number);
    const blocksBack = BigInt(10);
    const baseBlockNumber = currentBlockNumber > blocksBack ? currentBlockNumber - blocksBack : 1n;
    const baseBlock = await this.provider.getBlock(Number(baseBlockNumber));
    proofFacts = buildProofFacts(
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
    const details = this.getDefaultDetails();
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
      throw new Error(`Signature validation failed: expected ${VALIDATED}, got ${result[0]}`);
    }
  }
}
