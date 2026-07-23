/**
 * Call-based proving provider for testing
 *
 * This provider simulates proof generation by making a call to the contract
 * to execute the invocation and capture the output.
 */

import type { BlockIdentifier, constants, ETransactionVersion3, ProviderInterface } from "starknet";
import { CallData, EDAMode, hash, num, stark } from "starknet";
import type { Proof, ProofInvocation, ProofProviderInterface } from "../interfaces.js";
import { getDefaultProofDetails, extractExecuteViewCalldata } from "./proof-invocation-factory.js";
import { buildProofFacts, buildMessagePayload } from "../utils/proof-facts.js";
import { PrivacyPoolABI } from "./abi.js";

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
    const result = await this.compileActions(invocation, blockIdentifier);

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
   * Runs the pool's compile step. When signature validation is enabled and the invocation carries a
   * signature, it goes through `compile_actions_authorized` — the same authorization path
   * `__execute__` runs — so an unauthorized signature panics here just as it would on-chain.
   * Otherwise (fee simulation, or an unsigned mock invocation) it uses the plain `compile_actions`
   * view, which does no signature check.
   */
  private async compileActions(
    invocation: ProofInvocation,
    blockIdentifier?: BlockIdentifier
  ): Promise<string[]> {
    const signature = invocation.signature ? stark.formatSignature(invocation.signature) : [];
    if (this.options?.validateSignature === false || signature.length === 0) {
      return this.provider.callContract(
        {
          contractAddress: invocation.sender_address,
          entrypoint: "compile_actions",
          calldata: extractExecuteViewCalldata(invocation.calldata as string[]),
        },
        blockIdentifier
      );
    }
    return this.provider.callContract(
      {
        contractAddress: invocation.sender_address,
        entrypoint: "compile_actions_authorized",
        calldata: await this.buildAuthorizedCalldata(invocation, signature),
      },
      blockIdentifier
    );
  }

  /**
   * Builds the `compile_actions_authorized(calls, tx_info)` calldata. `calls` is the single
   * `compile_actions` call the account signed, unwrapped from the `__execute__` Array<Call>;
   * `tx_info` carries the signature and transaction hash. The pool reads only `signature` and
   * `transaction_hash` from it (and `chain_id` from the ambient view call), so the remaining fields
   * are left neutral.
   */
  private async buildAuthorizedCalldata(
    invocation: ProofInvocation,
    signature: string[]
  ): Promise<string[]> {
    const calldata = invocation.calldata as string[];
    // __execute__ calldata is a single-Call Array<Call>: [1, to, selector, inner_len, ...inner].
    const innerLength = Number(BigInt(calldata[3]));
    const calls = [
      { to: calldata[1], selector: calldata[2], calldata: calldata.slice(4, 4 + innerLength) },
    ];

    const details = await this.getDefaultDetails();
    const transactionHash = hash.calculateInvokeTransactionHash({
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

    const txInfo = {
      version: details.version,
      account_contract_address: num.toHex(invocation.sender_address),
      max_fee: 0,
      signature,
      transaction_hash: transactionHash,
      chain_id: this.chainId,
      nonce: details.nonce!,
      resource_bounds: [],
      tip: 0,
      paymaster_data: [],
      nonce_data_availability_mode: 0,
      fee_data_availability_mode: 0,
      account_deployment_data: [],
      proof_facts: [],
    };
    return new CallData(PrivacyPoolABI).compile("compile_actions_authorized", {
      calls,
      tx_info: txInfo,
    });
  }
}
