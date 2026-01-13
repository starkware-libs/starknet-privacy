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
import type { BlockIdentifier } from "starknet";
import type { PrivateKey } from "../utils/crypto.js";
import { AddressMap } from "../utils/maps.js";
import { createMockCallAndProof } from "./helpers.js";
import type { PrivacyPool } from "./pool.js";
import { MockDiscoveryProvider } from "./discovery.js";
import { PrivateTransfersBuilderImpl } from "../internal/builders.js";
import { ActionCompiler } from "../internal/compiler.js";
import { applyOptimisticUpdate } from "../internal/registry-updater.js";

export class MockPrivateTransfers implements PrivateTransfers {
  private pool: PrivacyPool;
  private _currentBlock: BlockIdentifier = 0;

  // User credentials (set via configure)
  private userAddress: StarknetAddress = "0x0";
  private userViewingKey: PrivateKey = 0n;
  private discoveryProvider: MockDiscoveryProvider;
  private compiler: ActionCompiler;

  constructor(pool: PrivacyPool, userAddress: StarknetAddress, userPrivateKey: PrivateKey) {
    this.pool = pool;
    this.discoveryProvider = new MockDiscoveryProvider(pool);
    this.userAddress = userAddress;
    this.userViewingKey = userPrivateKey;
    this.compiler = new ActionCompiler(userAddress, userPrivateKey, this.discoveryProvider);
  }

  async discoverRequirement(
    recipient: StarknetAddress,
    token: StarknetAddress
  ): Promise<SetupRequirement> {
    return this.discoveryProvider.discoverRequirement(
      this.userAddress,
      this.userViewingKey,
      recipient,
      token
    );
  }

  async execute(actions: Actions, options?: ExecuteOptions): Promise<ExecuteResult> {
    // 1. Compile actions - resolves contexts and produces clientActions
    const { clientActions, registry } = this.compiler.compile(actions, options);

    // 2. Execute client actions on the pool (returns callbacks, state is restored)
    const callbacks = this.pool.execute(this.userAddress, clientActions);

    // 3. Apply optimistic updates - update channel nonces, remove spent notes
    applyOptimisticUpdate(clientActions, registry);

    return {
      callAndProof: createMockCallAndProof(callbacks),
      registry,
    };
  }

  build(options?: ExecuteOptions): PrivateTransfersBuilder {
    return new PrivateTransfersBuilderImpl(this, this.userAddress, options);
  }

  discoverNotes(params: { since?: BlockIdentifier; known?: AddressMap<Note[]> } = {}): {
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
  } {
    return this.discoveryProvider.discoverNotes(this.userAddress, this.userViewingKey, params);
  }

  discoverChannels(...recipients: StarknetAddress[]): {
    timestamp: BlockIdentifier;
    channels: AddressMap<Channel>;
  } {
    return this.discoveryProvider.discoverChannels(
      this.userAddress,
      this.userViewingKey,
      ...recipients
    );
  }
}
