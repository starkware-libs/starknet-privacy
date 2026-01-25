/**
 * Mocknet - Test environment for mock privacy pool testing.
 *
 * Similar to Devnet but uses mock implementations instead of a real Starknet network.
 * Wires together MockPoolContract, MockProofProvider, and the factory abstractions.
 */

import type { ExecuteResult, PrivateRegistry, ViewingKey } from "../interfaces.js";
import { PrivateTransfers } from "../internal/private-transfers.js";
import { MockContracts } from "./contracts.js";
import { MockPoolContract } from "./mock-pool-contract.js";
import { MockProofProvider } from "./mock-proof-provider.js";
import { MockProofInvocationFactory } from "./mock-proof-invocation-factory.js";
import { ContractDiscoveryProvider } from "./contract-discovery.js";

/**
 * Mock account with address and private key.
 */
export interface MockAccount {
  address: bigint;
  privateKey: bigint;
}

/**
 * Mocknet environment - mirrors DevnetEnvironment structure.
 */
export interface MocknetEnvironment {
  alice: MockAccount;
  bob: MockAccount;
  carol: MockAccount;
  ace: string;
  bee: string;
  pool: MockPoolContract;
  contracts: MockContracts;
}

const ACCOUNTS = {
  alice: { address: 0xa11cen, privateKey: 12345n },
  bob: { address: 0xb0bn, privateKey: 67890n },
  carol: { address: 0xca201n, privateKey: 99999n },
};

const TOKENS = {
  ace: "0xace",
  bee: "0xbee",
};

/**
 * Mocknet configuration options.
 */
export interface MocknetOptions {
  /** Address for the mock pool contract (default: 0x123n) */
  poolAddress?: bigint;
  /** Whether to validate token balances (default: true) */
  validateBalances?: boolean;
}

/**
 * Test environment that wires mock implementations together.
 *
 * Usage:
 * ```typescript
 * const mocknet = new Mocknet();
 * const env = mocknet.initialize();
 * const transfers = mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey);
 * const result = await transfers.execute({ deposits: [...] });
 * mocknet.executeOutside(result); // Apply state changes
 * ```
 */
export class Mocknet {
  readonly contracts: MockContracts;
  readonly poolAddress: bigint;

  constructor(options: MocknetOptions = {}) {
    this.poolAddress = options.poolAddress ?? 0x123n;
    this.contracts = new MockContracts();

    // Create and register the mock pool contract
    const pool = new MockPoolContract(
      this.poolAddress,
      this.contracts,
      options.validateBalances ?? true
    );
    this.contracts.register(pool);
  }

  /**
   * Get the mock pool contract instance.
   */
  get pool(): MockPoolContract {
    return this.contracts.get<MockPoolContract>(this.poolAddress);
  }

  /**
   * Initialize the mocknet environment with predefined accounts and tokens.
   * Funds all users with 1000n of each token.
   *
   * @returns MocknetEnvironment with alice, bob, carol accounts and ace, bee tokens
   */
  initialize(): MocknetEnvironment {
    // Fund all users with 1000n of each token
    for (const account of Object.values(ACCOUNTS)) {
      this.fundUser(account.address, TOKENS.ace, 1000n);
      this.fundUser(account.address, TOKENS.bee, 1000n);
    }

    return {
      ...ACCOUNTS,
      ...TOKENS,
      pool: this.pool,
      contracts: this.contracts,
    };
  }

  /**
   * Fund a user with tokens.
   *
   * @param address - The user's address
   * @param token - The token address (hex string)
   * @param amount - The amount to fund
   */
  fundUser(address: bigint, token: string, amount: bigint): void {
    this.contracts.get(BigInt(token)).setBalance(address, amount);
  }

  /**
   * Create a PrivateTransfers instance configured for this mocknet.
   *
   * @param userAddress - The user's Starknet address
   * @param viewingKey - The user's viewing key (private key)
   */
  createPrivateTransfers(userAddress: bigint, viewingKey: ViewingKey): PrivateTransfers {
    const pool = this.pool;

    return new PrivateTransfers({
      // Mock account - only address is used
      account: { address: `0x${userAddress.toString(16)}` } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      viewingKeyProvider: { getViewingKey: () => viewingKey },
      provingProvider: new MockProofProvider(pool),
      discoveryProvider: new ContractDiscoveryProvider(pool),
      proofInvocationFactory: new MockProofInvocationFactory(),
      poolContractAddress: `0x${this.poolAddress.toString(16)}`,
    });
  }

  /**
   * Execute the actions from a CallAndProof result.
   * This applies the state changes to the mock pool.
   *
   * In real Starknet, this would be done by sending the transaction to the network.
   * In mocknet, we execute the actions directly on the pool.
   *
   * @param result - The ExecuteResult from PrivateTransfers.execute()
   * @returns The updated registry
   */
  executeOutside(result: ExecuteResult): PrivateRegistry {
    this.pool.execute_actions(result.callAndProof.call.calldata as string[]);
    return result.registry;
  }
}
