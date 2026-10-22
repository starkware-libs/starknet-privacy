/**
 * Call-based proving provider for testing
 *
 * This provider stands in for the real proving service by executing the invocation against a node
 * and capturing what the pool would have emitted, instead of generating a zero-knowledge proof.
 */

import type { BlockIdentifier, constants, ProviderInterface } from "starknet";
import { TransactionType, stark } from "starknet";
import type { Proof, ProofInvocation, ProofProviderInterface } from "../interfaces.js";
import { getDefaultProofDetails, extractExecuteViewCalldata } from "./proof-invocation-factory.js";
import {
  buildProofFacts,
  buildMessagePayload,
  type ProofFactsConfig,
} from "../utils/proof-facts.js";

/**
 * The blockifier accepts a proof only on a block whose hash is already stored: at most
 * `current_block - STORED_BLOCK_HASH_BUFFER`, where the current block is the one the transaction
 * lands in (at least latest + 1). Simulation enforces this too.
 * Source: `validate_proof_block_number`, crates/blockifier/src/transaction/account_transaction.rs:238,
 * and crates/blockifier/src/abi/constants.rs:39 at
 * https://github.com/starkware-libs/sequencer/tree/603f1bd8dca9da4c37b75841bf322bfa9d032d12
 */
const STORED_BLOCK_HASH_BUFFER = 10n;

/** Options for {@link CallMockProofProvider}. */
export type CallMockProofProviderOptions = {
  /** When false, compile through the `compile_actions` view without checking the signature. */
  validateSignature?: boolean;
  /**
   * Overrides for the protocol fields of the proof facts. Without a `starknetVersion`, the base
   * block's `starknet_version` selects the defaults, so devnet (0.14.2) and current networks both
   * accept the facts.
   */
  proofFactsConfig?: ProofFactsConfig;
};

/** An L2-to-L1 message in a simulation trace. */
interface TraceMessage {
  to_address: string;
  payload: string[];
}

/**
 * The RPC spec wraps trace messages as ORDERED_MESSAGE (`{ order, message }`); some nodes (devnet)
 * return the MSG_TO_L1 unwrapped. Both shapes occur in practice.
 */
type TraceMessageEntry = TraceMessage | { order: number; message: TraceMessage };

interface TraceInvocation {
  messages?: TraceMessageEntry[];
  calls?: TraceInvocation[];
}

interface SimulationResult {
  transaction_trace?: { execute_invocation?: TraceInvocation };
}

/**
 * The simulate surface this provider needs. `RpcProvider` does not implement `simulateTransaction`
 * itself — only its public `channel` does — so the capability is reached structurally rather than by
 * widening the constructor's `ProviderInterface`.
 */
interface SimulateCapableNode {
  channel?: {
    simulateTransaction?: (
      invocations: unknown,
      options?: {
        blockIdentifier?: BlockIdentifier;
        skipValidate?: boolean;
        skipFeeCharge?: boolean;
      }
    ) => Promise<unknown>;
  };
}

/** The pool's compile step output: the class hash and the serialized server actions. */
interface CompiledActions {
  poolClassHash: string;
  serverActions: string[];
}

function unwrapMessage(entry: TraceMessageEntry): TraceMessage {
  return "message" in entry ? entry.message : entry;
}

/** Depth-first collect of every L2-to-L1 message in an invocation subtree. */
function collectMessages(invocation: TraceInvocation | undefined): TraceMessage[] {
  if (invocation == null) return [];
  return [
    ...(invocation.messages ?? []).map(unwrapMessage),
    ...(invocation.calls ?? []).flatMap(collectMessages),
  ];
}

/**
 * A proving provider that uses Starknet calls to simulate proof generation.
 * This is useful for testing where we want to execute the contract logic
 * without actually generating zero-knowledge proofs.
 */
export class CallMockProofProvider implements ProofProviderInterface {
  constructor(
    protected readonly node: ProviderInterface,
    protected readonly chainId: constants.StarknetChainId,
    private readonly options?: CallMockProofProviderOptions
  ) {}

  async getDefaultDetails() {
    return getDefaultProofDetails(this.chainId);
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: BlockIdentifier): Promise<Proof> {
    const { poolClassHash, serverActions } = await this.compileActions(invocation, blockIdentifier);

    // The base block is the requested one (latest by default), moved back to the newest block
    // whose hash the blockifier can verify, so a `latest` or other recent block is not rejected
    // as too recent.
    const latestBlock = await this.node.getBlock("latest");
    const latestBlockNumber = BigInt(latestBlock.block_number);
    const newestProvableBlockNumber =
      latestBlockNumber > STORED_BLOCK_HASH_BUFFER
        ? latestBlockNumber - STORED_BLOCK_HASH_BUFFER
        : 1n;
    const requestedBlockNumber =
      blockIdentifier == null
        ? latestBlockNumber
        : BigInt((await this.node.getBlock(blockIdentifier)).block_number);
    const baseBlockNumber =
      requestedBlockNumber < newestProvableBlockNumber
        ? requestedBlockNumber
        : newestProvableBlockNumber;
    const baseBlock = await this.node.getBlock(Number(baseBlockNumber));
    const proofFactsConfig = this.options?.proofFactsConfig;
    const proofFacts = buildProofFacts(
      invocation.sender_address,
      poolClassHash,
      serverActions,
      baseBlockNumber,
      baseBlock.block_hash ?? "0x0",
      this.chainId,
      {
        ...proofFactsConfig,
        starknetVersion: proofFactsConfig?.starknetVersion ?? baseBlock.starknet_version,
      }
    );

    // Return the full L2-to-L1 message payload: [class_hash, ...serialized_actions].
    // This matches the real proving service behavior. The consumer must strip the
    // class_hash prefix before passing to apply_actions.
    return {
      output: buildMessagePayload(poolClassHash, serverActions),
      data: undefined!,
      proofFacts,
    };
  }

  /**
   * Runs the pool's compile step. A signed invocation is simulated as a real `__execute__` invoke, so
   * the pool itself runs `assert_valid_signature` — every accepted signature form (custom validation,
   * transaction hash, SNIP-12 `CallSet`) is honored exactly as on-chain, and an unauthorized one
   * panics with `INVALID_SIGNATURE`. Fee simulation and unsigned mock invocations instead use the
   * plain `compile_actions` view, which performs no signature check because a view has no `tx_info`.
   */
  private async compileActions(
    invocation: ProofInvocation,
    blockIdentifier?: BlockIdentifier
  ): Promise<CompiledActions> {
    const signature = invocation.signature ? stark.formatSignature(invocation.signature) : [];
    if (this.options?.validateSignature === false || signature.length === 0) {
      const [serverActions, poolClassHash] = await Promise.all([
        this.node.callContract(
          {
            contractAddress: invocation.sender_address,
            entrypoint: "compile_actions",
            calldata: extractExecuteViewCalldata(invocation.calldata as string[]),
          },
          blockIdentifier
        ),
        this.node.getClassHashAt(invocation.sender_address, blockIdentifier),
      ]);
      return { poolClassHash, serverActions };
    }
    return this.simulateExecute(invocation, signature, blockIdentifier);
  }

  /**
   * Simulates the invocation as an `__execute__` invoke and reads the compile output back out of the
   * L2-to-L1 message the pool emits (`send_message_to_server`), whose payload is
   * `[class_hash, ...server_actions]` — so the class hash needs no separate query.
   */
  private async simulateExecute(
    invocation: ProofInvocation,
    signature: string[],
    blockIdentifier?: BlockIdentifier
  ): Promise<CompiledActions> {
    const channel = (this.node as unknown as SimulateCapableNode).channel;
    if (channel?.simulateTransaction == null) {
      throw new Error(
        "CallMockProofProvider needs a node whose channel supports simulateTransaction to validate " +
          "signatures; pass validateSignature: false to compile without validation"
      );
    }

    const simulation = (await channel.simulateTransaction(
      [
        {
          type: TransactionType.INVOKE,
          contractAddress: invocation.sender_address,
          calldata: invocation.calldata,
          signature,
          nonce: invocation.nonce,
          version: invocation.version,
          resourceBounds: invocation.resource_bounds,
          tip: invocation.tip,
          paymasterData: invocation.paymaster_data,
          accountDeploymentData: invocation.account_deployment_data,
          nonceDataAvailabilityMode: invocation.nonce_data_availability_mode,
          feeDataAvailabilityMode: invocation.fee_data_availability_mode,
        },
      ],
      // skipValidate drops only __validate__'s zero-tip / zero-resource-price assertions; the
      // signature check lives in __execute__ and still runs. skipFeeCharge is required, not
      // cosmetic: __validate__ demands a zero max_price_per_unit, so the invocation carries zero
      // resource bounds and the node's fee-bounds pre-check would otherwise reject the transaction
      // before __execute__ runs ("resources don't cover the minimal transaction fee"). It is passed
      // explicitly rather than relying on the client's default.
      { blockIdentifier, skipValidate: true, skipFeeCharge: true }
    )) as SimulationResult[];

    const payload = collectMessages(simulation?.[0]?.transaction_trace?.execute_invocation).find(
      (message) => BigInt(message.to_address) === 0n
    )?.payload;
    if (payload == null || payload.length === 0) {
      throw new Error(
        "simulated __execute__ emitted no server message; the pool did not compile the actions"
      );
    }
    return { poolClassHash: payload[0], serverActions: payload.slice(1) };
  }
}
