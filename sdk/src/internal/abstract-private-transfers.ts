/**
 * Abstract base class for PrivateTransfers implementations
 *
 * Provides default implementations for discovery methods and builder creation,
 * leaving only the execute method as abstract for subclasses to implement.
 */

import type { BlockIdentifier } from "starknet";
import type {
  Actions,
  Channel,
  DiscoveryLevel,
  DiscoveryProviderInterface,
  ExecuteOptions,
  ExecuteResult,
  Note,
  NotesCursor,
  PrivateRegistry,
  PrivateTransfersBuilder,
  PrivateTransfersInterface,
  ProofInvocationResult,
  ProvingBlockId,
  StarknetAddress,
  StarknetAddressBigint,
  ViewingKey,
  ViewingKeyProvider,
} from "../interfaces.js";
import { SetupRequirement } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { toBigInt } from "../utils/crypto.js";
import { PrivateTransfersBuilderImpl } from "./builders.js";

/**
 * Abstract base class that implements the common functionality for PrivateTransfers.
 * Subclasses only need to implement the execute method.
 */
export abstract class AbstractPrivateTransfers implements PrivateTransfersInterface {
  readonly user: StarknetAddressBigint;

  constructor(
    userAddress: StarknetAddress,
    protected readonly viewingKeyProvider: ViewingKeyProvider,
    protected readonly discoveryProvider: DiscoveryProviderInterface
  ) {
    this.user = toBigInt(userAddress);
  }

  /**
   * Get the current viewing key from the provider
   */
  protected async getViewingKey(): Promise<ViewingKey> {
    return await this.viewingKeyProvider.getViewingKey();
  }

  /**
   * Discover unspent notes per token.
   * When `registry` and `level` are provided, updates the registry in-place.
   */
  async discoverNotes(
    params: {
      registry?: PrivateRegistry;
      level?: DiscoveryLevel;
      tokens?: StarknetAddressBigint[];
    } = {}
  ): Promise<{
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
    cursor: NotesCursor;
  }> {
    const { registry, level, tokens } = params;

    const result = await this.discoveryProvider.discoverNotes(
      this.user,
      await this.getViewingKey(),
      { cursor: level === "missing" ? registry?.notesCursor : undefined, tokens }
    );

    if (registry) {
      registry.applyDiscoveredNotes(level, result.notes, result.cursor);
    }

    return { timestamp: result.timestamp, notes: result.notes, cursor: result.cursor };
  }

  /**
   * Discover channels for one or more recipients.
   * When `registry` is provided, updates `channelCursor` in-place.
   */
  async discoverChannels(
    params: {
      registry?: PrivateRegistry;
      level?: DiscoveryLevel;
      recipients?: StarknetAddress[];
    } = {}
  ): Promise<{
    timestamp: BlockIdentifier;
    channels?: AddressMap<Channel>;
    total?: number;
  }> {
    const { registry, level, recipients } = params;

    const result = await this.discoveryProvider.discoverChannels(
      this.user,
      await this.getViewingKey(),
      {
        recipients: recipients?.map(toBigInt),
        cursor: level === "missing" ? registry?.channelCursor : undefined,
      }
    );

    if (registry) {
      registry.applyDiscoveredChannels(result.cursor);
    }

    return {
      timestamp: result.timestamp,
      channels: result.channels,
      total: result.total,
    };
  }

  /**
   * Check the setup requirements for a recipient and token
   */
  async discoverRequirement(
    recipient: StarknetAddress,
    token: StarknetAddress
  ): Promise<SetupRequirement> {
    return this.discoveryProvider.discoverRequirement(
      this.user,
      await this.getViewingKey(),
      toBigInt(recipient),
      toBigInt(token)
    );
  }

  /**
   * Create a builder for batching multiple operations
   */
  build(options?: ExecuteOptions): PrivateTransfersBuilder {
    return new PrivateTransfersBuilderImpl(this, this.user, options);
  }

  /**
   * Execute raw actions: compile, prove, and return the call+proof.
   */
  async execute(actions: Actions, options?: ExecuteOptions): Promise<ExecuteResult> {
    const invocationResult = await this.createProofInvocation(actions, options);
    return this.executeWithInvocation(invocationResult, options?.provingBlockId);
  }

  /**
   * Build a proof transaction for the raw actions - must be implemented by subclasses
   */
  abstract createProofInvocation(
    actions: Actions,
    options?: Omit<ExecuteOptions, "provingBlockId">
  ): Promise<ProofInvocationResult>;

  /**
   * Execute a pre-built proof invocation: prove it and return the call+proof ready for submission.
   */
  abstract executeWithInvocation(
    invocation: ProofInvocationResult,
    provingBlockId?: ProvingBlockId
  ): Promise<ExecuteResult>;
}
