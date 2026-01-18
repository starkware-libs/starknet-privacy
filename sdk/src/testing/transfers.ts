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
import { AddressMap, toBigInt } from "../utils/index.js";
import { createMockCallAndProof } from "./helpers.js";
import type { PrivacyPool } from "./pool.js";
import { MockDiscoveryProvider } from "./discovery.js";
import { PrivateTransfersBuilderImpl } from "../internal/builders.js";
import { ActionCompiler } from "../internal/compiler.js";
import { MockContracts } from "./contracts.js";
import { debugLog } from "../utils/logging.js";

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
    const { clientActions, registry } = this.compiler.compile(actions, options);

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

  discoverNotes(params: { since?: BlockIdentifier; known?: AddressMap<Note[]> } = {}): {
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
  } {
    return this.discoveryProvider.discoverNotes(this.user, this.userViewingKey, params);
  }

  discoverChannels(...recipients: StarknetAddress[]): {
    timestamp: BlockIdentifier;
    channels: AddressMap<Channel>;
  } {
    return this.discoveryProvider.discoverChannels(
      this.user,
      this.userViewingKey,
      ...recipients.map(toBigInt)
    );
  }
}
