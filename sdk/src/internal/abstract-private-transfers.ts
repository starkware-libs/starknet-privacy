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
  DiscoveryProviderInterface,
  ExecuteOptions,
  ExecuteResult,
  Note,
  PrivateTransfersBuilder,
  PrivateTransfersInterface,
  ProofInvocationResult,
  StarknetAddress,
  StarknetAddressBigint,
  ViewingKey,
  ViewingKeyProvider,
} from "../interfaces.js";
import { SetupRequirement } from "../interfaces.js";
import { AddressMap } from "../utils/maps.js";
import { toBigInt } from "../utils/crypto.js";
import { PrivateTransfersBuilderImpl } from "./builders.js";
import type { ChannelCursor, NotesCursor } from "./channel.js";

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
   * Discover unspent notes per token
   */
  async discoverNotes(params: { since?: BlockIdentifier; cursor?: NotesCursor } = {}): Promise<{
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
  }> {
    return this.discoveryProvider.discoverNotes(this.user, await this.getViewingKey(), params);
  }

  /**
   * Discover channels for one or more recipients.
   * Omit `recipients` to discover all outgoing channels.
   */
  async discoverChannels(
    params: {
      recipients?: StarknetAddress[];
      cursor?: ChannelCursor;
    } = {}
  ): Promise<{
    timestamp: BlockIdentifier;
    channels?: AddressMap<Channel>;
    total?: number;
  }> {
    const { recipients, ...rest } = params;
    return this.discoveryProvider.discoverChannels(
      this.user,
      await this.getViewingKey(),
      { recipients: recipients?.map(toBigInt), ...rest }
    );
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
   * Execute raw actions - must be implemented by subclasses
   */
  abstract execute(actions: Actions, options?: ExecuteOptions): Promise<ExecuteResult>;

  /**
   * Build a proof transaction for the raw actions - must be implemented by subclasses
   */
  abstract createProofInvocation(
    actions: Actions,
    options?: ExecuteOptions
  ): Promise<ProofInvocationResult>;
}
