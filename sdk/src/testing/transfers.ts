/**
 * Mock PrivateTransfers implementation for testing.
 */

import type { Actions, ExecuteOptions, ExecuteResult, StarknetAddress } from "../interfaces.js";
import type { PrivateKey } from "../utils/crypto.js";
import { toBigInt } from "../utils/index.js";
import { createMockCallAndProof } from "./helpers.js";
import type { MockPoolContract } from "./mock-pool-contract.js";
import { ContractDiscoveryProvider } from "./contract-discovery.js";
import { ActionCompiler } from "../internal/compiler.js";
import { MockContracts } from "./contracts.js";
import { consoleLogCallback, debugLog, withLogging } from "../utils/logging.js";
import { AbstractPrivateTransfers } from "../internal/abstract-private-transfers.js";

export class MockPrivateTransfers extends AbstractPrivateTransfers {
  private compiler: ActionCompiler;
  private pool: MockPoolContract;

  constructor(
    contracts: MockContracts,
    poolAddress: StarknetAddress,
    userAddress: StarknetAddress,
    userPrivateKey: PrivateKey
  ) {
    const pool = contracts.get<MockPoolContract>(toBigInt(poolAddress));
    super(userAddress, { getViewingKey: () => userPrivateKey }, new ContractDiscoveryProvider(pool));
    this.pool = pool;
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

    // 2. Execute client actions (execute_view handles snapshot/restore internally)
    const serverActions = this.pool.execute(
      this.user,
      toBigInt(await this.getViewingKey()),
      ...clientActions
    );

    return {
      callAndProof: createMockCallAndProof(serverActions),
      registry,
    };
  }
}
