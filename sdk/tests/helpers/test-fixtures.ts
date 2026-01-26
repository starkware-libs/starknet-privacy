import { MockContracts, MockPoolContract, MockPrivateTransfers } from "../../src/testing/index.js";
import { withLogging, consoleLogCallback, toBigInt } from "../../src/utils/index.js";
import {
  createEmptyRegistry,
  ExecuteOptions,
  ExecuteResult,
  PrivateRegistry,
} from "../../src/interfaces.js";

// Test addresses and keys (must be valid hex addresses convertible to BigInt)
export const POOL_ADDRESS = toBigInt("0x1");
export const ACE = toBigInt("0xACE"); // Token A
export const BEE = toBigInt("0xBEE"); // Token B

export const ALICE = { address: toBigInt("0xA11CE"), privateKey: 12345n };
export const BOB = { address: toBigInt("0xB0B"), privateKey: 67890n };
export const CAROL = { address: toBigInt("0xCA201"), privateKey: 99999n };

// Default options presets - for operations AFTER registration and setup are done
export const AUTO_ALL: ExecuteOptions = {
  autoRegister: true,
  autoDiscover: { channels: "refresh", notes: "refresh" },
  autoSetup: true,
  autoSelectNotes: "naive",
};

export const AUTO_CHANNELS_ONLY: ExecuteOptions = {
  autoDiscover: { channels: "refresh" },
  autoSetup: true,
};

export const AUTO_DISCOVERY_ONLY: ExecuteOptions = {
  autoDiscover: { channels: "refresh", notes: "refresh" },
};

// Test environment factory
export interface TestEnv {
  contracts: MockContracts;
  pool: MockPoolContract;
  alice: MockPrivateTransfers;
  bob: MockPrivateTransfers;
  carol: MockPrivateTransfers;
  fundUser: (address: bigint, token: bigint, amount: bigint) => void;
  executeOutside: (result: ExecuteResult) => PrivateRegistry;
}

export function createTestEnv(): TestEnv {
  const contracts = new MockContracts();
  const pool = withLogging(
    new MockPoolContract(POOL_ADDRESS, contracts),
    "MockPoolContract",
    consoleLogCallback
  );
  contracts.register(pool);

  const alice = new MockPrivateTransfers(contracts, POOL_ADDRESS, ALICE.address, ALICE.privateKey);
  const bob = new MockPrivateTransfers(contracts, POOL_ADDRESS, BOB.address, BOB.privateKey);
  const carol = new MockPrivateTransfers(contracts, POOL_ADDRESS, CAROL.address, CAROL.privateKey);

  const fundUser = (address: bigint, token: bigint, amount: bigint) => {
    contracts.get(token).setBalance(address, amount);
  };

  const executeOutside = (result: ExecuteResult) => {
    pool.execute_actions(result.callAndProof.call.calldata as string[]);
    return result.registry;
  };

  // Default funding
  fundUser(ALICE.address, ACE, 1000n);
  fundUser(ALICE.address, BEE, 500n);

  return { contracts, pool, alice, bob, carol, fundUser, executeOutside };
}

// Re-export commonly used utilities
export { createEmptyRegistry };
