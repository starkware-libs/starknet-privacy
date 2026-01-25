/**
 * Mock PrivateTransfers implementation for testing.
 */

import type { Actions, ExecuteOptions, ExecuteResult, StarknetAddress } from "../interfaces.js";
import type { PrivateKey } from "../utils/crypto.js";
import { toBigInt } from "../utils/index.js";
import { createMockCallAndProof } from "./helpers.js";
import type { MockPoolContract } from "./mock-pool-contract.js";
import { MockDiscoveryProvider } from "./discovery.js";
import { ActionCompiler } from "../internal/compiler.js";
import { MockContracts } from "./contracts.js";
import { consoleLogCallback, debugLog, withLogging } from "../utils/logging.js";
import { AbstractPrivateTransfers } from "../internal/abstract-private-transfers.js";

export class MockPrivateTransfers extends AbstractPrivateTransfers {
  // User credentials (set via configure)
  private compiler: ActionCompiler;
  private pool: MockPoolContract;

  constructor(
    private contracts: MockContracts,
    poolAddress: StarknetAddress,
    userAddress: StarknetAddress,
    userPrivateKey: PrivateKey
  ) {
    super(
      userAddress,
      { getViewingKey: () => userPrivateKey },
      new MockDiscoveryProvider(contracts.get<MockPoolContract>(toBigInt(poolAddress)))
    );
    this.pool = contracts.get<MockPoolContract>(toBigInt(poolAddress));
    this.compiler = withLogging(
      new ActionCompiler(this.user, userPrivateKey, this.discoveryProvider),
      "Compiler",
      consoleLogCallback
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
}
