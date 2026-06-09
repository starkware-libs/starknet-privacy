/**
 * Call-based proving provider for testing
 *
 * This provider simulates proof generation by making a call to the contract
 * to execute the invocation and capture the output.
 */

import type { BlockIdentifier, constants, ETransactionVersion3, ProviderInterface } from "starknet";
import { EDAMode, encode, hash, num, stark } from "starknet";
import type {
  AdditionalData,
  Proof,
  ProofInvocation,
  ProofProviderInterface,
} from "../interfaces.js";
import { getDefaultProofDetails } from "../internal/proof-invocation-factory.js";
import { ProvingServiceError } from "../internal/proving-service.js";
import { buildProofFacts, buildMessagePayload } from "../utils/proof-facts.js";
import { toBigInt } from "../utils/convert.js";
import { extractExecuteViewCalldata } from "../internal/proof-invocation-factory.js";
import { chainIdShortString, signDepositorValidation } from "./screening-signer.js";

// `ServerAction` enum variant indices (declaration order in `actions.cairo`).
const TRANSFER_FROM_VARIANT = 2n;
const EMIT_DEPOSIT_VARIANT = 6n;

/**
 * Find the regular-pool depositor (`TransferFrom.from_addr`) in a serialized `Span<ServerAction>`,
 * or `undefined` when there is no deposit.
 *
 * A `deposit` client action compiles to exactly `[TransferFrom, EmitDeposit]`, adjacent and sharing
 * the same `(addr, token, amount)`:
 *   `[2, from_addr, token, amount, 6, user_addr, token, amount]`.
 * Matching that signature is a robust, unique marker — it avoids decoding the whole enum span
 * (unreliable for the event-bearing variants) without needing per-variant length bookkeeping.
 */
function findDepositor(actions: string[]): string | undefined {
  for (let i = 0; i + 7 < actions.length; i++) {
    if (
      BigInt(actions[i]) === TRANSFER_FROM_VARIANT &&
      BigInt(actions[i + 4]) === EMIT_DEPOSIT_VARIANT &&
      BigInt(actions[i + 1]) === BigInt(actions[i + 5]) &&
      BigInt(actions[i + 2]) === BigInt(actions[i + 6]) &&
      BigInt(actions[i + 3]) === BigInt(actions[i + 7])
    ) {
      return num.toHex(actions[i + 1]);
    }
  }
  return undefined;
}

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
    private readonly chainId: constants.StarknetChainId,
    /**
     * Private key of the screener the privacy contract was deployed with. When set, deposits are
     * screened: the provider signs a `DepositorValidation` for the deposit's `from_addr` and
     * returns it as `additionalData`, mirroring the real screening service. Omit for flows that
     * deploy without screening.
     */
    private readonly screenerPrivateKey?: string
  ) {}

  async getDefaultDetails() {
    return getDefaultProofDetails(this.chainId);
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: BlockIdentifier): Promise<Proof> {
    // Validate signature similar to how __execute__ does in the contract.
    // compile_actions skips this since view functions don't have tx_info.
    await this.validateSignature(invocation);

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

    // Screen the deposit (if any): sign a DepositorValidation for its from_addr under the
    // configured screener key, as the real screening service would. issued_at is a recent block
    // timestamp so the on-chain freshness check passes.
    const additionalData = this.screenDeposit(result, Number(latestBlock.timestamp));
    return { output: messagePayload, data: undefined!, proofFacts, additionalData };
  }

  /**
   * Sign a screening attestation for the proven deposit's `from_addr`. Returns `undefined`
   * (→ `Option::None`) when no screener key is configured or the tx carries no deposit.
   */
  private screenDeposit(actions: string[], issuedAt: number): AdditionalData | undefined {
    if (!this.screenerPrivateKey) {
      return undefined;
    }
    const depositor = findDepositor(actions);
    if (depositor === undefined) {
      return undefined;
    }
    const signature = signDepositorValidation(
      this.screenerPrivateKey,
      depositor,
      issuedAt,
      chainIdShortString(this.chainId)
    );
    return { signature };
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
