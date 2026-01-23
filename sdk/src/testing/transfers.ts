/**
 * Mock PrivateTransfers implementation for testing.
 */

import type {
  Actions,
  ExecuteOptions,
  ExecuteResult,
  Note,
  PrivateTransfers,
  PrivateTransfersBuilder,
  StarknetAddress,
} from "../interfaces.js";
import { Channel, SetupRequirement } from "../interfaces.js";
import type { NotesCursor } from "../internal/channel.js";
import type { BlockIdentifier } from "starknet";
import { num } from "starknet";
import type { PrivateKey } from "../utils/crypto.js";
import { AddressMap } from "../utils/maps.js";
import { createMockCallAndProof } from "./helpers.js";
import type { PrivacyPool } from "./pool.js";
import { MockDiscoveryProvider } from "./discovery.js";
import { PrivateTransfersBuilderImpl } from "../internal/builders.js";
import { ActionCompiler } from "../internal/compiler.js";
import { MockContracts } from "./contracts.js";
import { debugLog } from "../utils/logging.js";

/** Normalize BigNumberish to bigint */
const toBigInt = (value: StarknetAddress): bigint => num.toBigInt(value);

export class MockPrivateTransfers implements PrivateTransfers {
  // User credentials (set via configure)
  readonly user: bigint;
  private userViewingKey: PrivateKey = 0n;
  private discoveryProvider: MockDiscoveryProvider;
  private compiler: ActionCompiler;
  private pool: PrivacyPool;

  constructor(
    private contracts: MockContracts,
    poolAddress: StarknetAddress,
    userAddress: StarknetAddress,
    userPrivateKey: PrivateKey
  ) {
    this.pool = this.contracts.get<PrivacyPool>(toBigInt(poolAddress));
    this.discoveryProvider = new MockDiscoveryProvider(this.pool);
    this.user = toBigInt(userAddress);
    this.userViewingKey = userPrivateKey;
    this.compiler = new ActionCompiler(this.user, userPrivateKey, this.discoveryProvider);
  }

  async discoverRequirement(
    recipient: StarknetAddress,
    token: StarknetAddress
  ): Promise<SetupRequirement> {
    return this.discoveryProvider.discoverRequirement(
      this.user,
      this.userViewingKey,
      toBigInt(recipient),
      toBigInt(token)
    );
  }

  async execute(actions: Actions, options?: ExecuteOptions): Promise<ExecuteResult> {
    debugLog("private-transfers", "execute", actions);
    // 1. Compile actions - resolves contexts and produces clientActions
    const { clientActions, registry } = await this.compiler.compile(actions, options);

    debugLog("private-transfers", "clientActions", clientActions);

    const snapshot = this.contracts.snapshot();
    // 2. Execute client actions on the pool (returns callbacks, state is restored)
    const callbacks = this.pool.execute(this.user, ...clientActions);

    this.contracts.restore(snapshot);
    // 3. Apply optimistic updates - update channel nonces, remove spent notes
    //applyOptimisticUpdate(clientActions, registry);

    return {
      callAndProof: createMockCallAndProof(callbacks),
      registry,
    };
  }

  build(options?: ExecuteOptions): PrivateTransfersBuilder {
    return new PrivateTransfersBuilderImpl(this, this.user, options);
  }

  async discoverNotes(params?: { cursor?: NotesCursor; tokens?: bigint[] }): Promise<{
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
  }> {
    const result = await this.discoveryProvider.discoverNotes(
      this.user,
      this.userViewingKey,
      params
    );
    return { timestamp: result.timestamp, notes: result.notes };
  }

  async discoverChannels(
    recipients: StarknetAddress[],
    params?: { cursor?: AddressMap<Channel> }
  ): Promise<{
    timestamp: BlockIdentifier;
    channels: AddressMap<Channel>;
  }> {
    return this.discoveryProvider.discoverChannels(
      this.user,
      this.userViewingKey,
      recipients.map(toBigInt),
      params
    );
  }
}
