import {
  MockContracts,
  PrivacyPool,
  MockPrivateTransfers,
  applyStateChanges,
} from "../../src/testing/index.js";
import { withLogging, consoleLogCallback } from "../../src/utils/index.js";
import { createEmptyRegistry, ExecuteOptions, PrivateRegistry } from "../../src/interfaces.js";
import { num } from "starknet";

/** Normalize BigNumberish to bigint */
const toBigInt = (value: string | bigint | number): bigint => num.toBigInt(value);

// Test addresses and keys (must be valid hex addresses convertible to BigInt)
export const POOL_ADDRESS = toBigInt("0x1");
export const ACE = toBigInt("0xACE"); // Token A
export const BEE = toBigInt("0xBEE"); // Token B

export const ALICE = { address: toBigInt("0xA11CE"), privateKey: 12345n };
export const BOB = { address: toBigInt("0xB0B"), privateKey: 67890n };
export const CAROL = { address: toBigInt("0xCA201"), privateKey: 99999n };

// Default options presets - for operations AFTER registration and setup are done
export const AUTO_ALL: ExecuteOptions = {
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
  pool: PrivacyPool;
  alice: MockPrivateTransfers;
  bob: MockPrivateTransfers;
  carol: MockPrivateTransfers;
  fundUser: (address: bigint, token: bigint, amount: bigint) => void;
}

export function createTestEnv(): TestEnv {
  const contracts = new MockContracts();
  const pool = withLogging(
    new PrivacyPool(POOL_ADDRESS, contracts),
    "PrivacyPool",
    consoleLogCallback
  );
  contracts.register(pool);

  const alice = new MockPrivateTransfers(contracts, POOL_ADDRESS, ALICE.address, ALICE.privateKey);
  const bob = new MockPrivateTransfers(contracts, POOL_ADDRESS, BOB.address, BOB.privateKey);
  const carol = new MockPrivateTransfers(contracts, POOL_ADDRESS, CAROL.address, CAROL.privateKey);

  const fundUser = (address: bigint, token: bigint, amount: bigint) => {
    contracts.get(token).setBalance(address, amount);
  };

  // Default funding
  fundUser(ALICE.address, ACE, 1000n);
  fundUser(ALICE.address, BEE, 500n);

  return { contracts, pool, alice, bob, carol, fundUser };
}

// Setup helper: register user and set up self-channel with token
// Returns updated registry with token info
export async function setupSelfChannel(
  user: MockPrivateTransfers,
  userAddress: bigint,
  token: bigint
): Promise<PrivateRegistry> {
  applyStateChanges(await user.build().register().execute());
  applyStateChanges(await user.build().setup(userAddress).execute());

  let channel = user.discoverChannels(userAddress).channels.get(userAddress)!;
  const registry = createEmptyRegistry();
  registry.channels.set(userAddress, channel);

  applyStateChanges(await user.build({ registry }).with(token).setup(userAddress).execute());

  // Refresh channel to include token info
  channel = user.discoverChannels(userAddress).channels.get(userAddress)!;
  registry.channels.set(userAddress, channel);

  return registry;
}

// Setup helper: register sender and set up channel to recipient with token
// Returns updated registry with token info
export async function setupRecipientChannel(
  sender: MockPrivateTransfers,
  recipient: MockPrivateTransfers,
  recipientAddress: bigint,
  token: bigint
): Promise<PrivateRegistry> {
  // Recipient must be registered first
  applyStateChanges(await recipient.build().register().execute());

  // Sender sets up channel to recipient
  applyStateChanges(await sender.build().setup(recipientAddress).execute());

  let channel = sender.discoverChannels(recipientAddress).channels.get(recipientAddress)!;
  const registry = createEmptyRegistry();
  registry.channels.set(recipientAddress, channel);

  applyStateChanges(await sender.build({ registry }).with(token).setup(recipientAddress).execute());

  // Refresh channel to include token info
  channel = sender.discoverChannels(recipientAddress).channels.get(recipientAddress)!;
  registry.channels.set(recipientAddress, channel);

  return registry;
}

// Re-export commonly used utilities
export { applyStateChanges, createEmptyRegistry };
