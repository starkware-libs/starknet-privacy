// Import directly from specific modules to avoid loading devnet.js (Node-only)
import { Mocknet, type MocknetEnvironment } from "../../src/testing/mocknet.js";
import { MockPoolContract } from "../../src/testing/mock-pool-contract.js";
import {
  createEmptyRegistry,
  ExecuteOptions,
  ExecuteResult,
  PrivateRegistry,
  PrivateTransfersInterface,
} from "../../src/interfaces.js";

export const POOL_ADDRESS = 0x1n;
/** Used by `account-deposit.test.ts` to stand in for a deployed `DepositAnonymizer`. */
export const DEPOSIT_ANONYMIZER_ADDRESS = 0xa1n;

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
export interface MockTestEnv {
  mocknet: Mocknet;
  env: MocknetEnvironment;
  transfers: {
    alice: PrivateTransfersInterface;
    bob: PrivateTransfersInterface;
    carol: PrivateTransfersInterface;
    david: PrivateTransfersInterface;
  };
}

export function createTestEnv(): MockTestEnv {
  const mocknet = new Mocknet({ poolAddress: POOL_ADDRESS });
  const env = mocknet.initialize(); // Funds all users with 1000n of ace/bee

  const transfers = {
    alice: mocknet.createPrivateTransfers(env.alice.address, env.alice.privateKey),
    bob: mocknet.createPrivateTransfers(env.bob.address, env.bob.privateKey),
    carol: mocknet.createPrivateTransfers(env.carol.address, env.carol.privateKey),
    david: mocknet.createPrivateTransfers(env.david.address, env.david.privateKey),
  };

  return { mocknet, env, transfers };
}

// Tests use: mocknet.fundUser(), mocknet.executeOutside()

// Setup helper: register user and set up self-channel with token
// Returns updated registry with token info
export async function setupSelfChannel(
  user: PrivateTransfersInterface,
  userAddress: bigint,
  token: bigint,
  pool: MockPoolContract
): Promise<PrivateRegistry> {
  const executeOutside = (result: ExecuteResult) => {
    pool.apply_actions(result.callAndProof.call.calldata as string[]);
    return result.registry;
  };

  executeOutside(await user.build().register().execute());
  executeOutside(await user.build().setup(userAddress).execute());

  let channel = (await user.discoverChannels([userAddress])).channels.get(userAddress)!;
  const registry = createEmptyRegistry();
  registry.channels.set(userAddress, channel);

  executeOutside(await user.build({ registry }).with(token).setup(userAddress).execute());

  // Refresh channel to include token info
  channel = (await user.discoverChannels([userAddress])).channels.get(userAddress)!;
  registry.channels.set(userAddress, channel);

  return registry;
}

// Setup helper: register sender and set up channel to recipient with token
// Returns updated registry with token info
export async function setupRecipientChannel(
  sender: PrivateTransfersInterface,
  recipient: PrivateTransfersInterface,
  recipientAddress: bigint,
  token: bigint,
  pool: MockPoolContract
): Promise<PrivateRegistry> {
  const executeOutside = (result: ExecuteResult) => {
    pool.apply_actions(result.callAndProof.call.calldata as string[]);
    return result.registry;
  };

  // Recipient must be registered first
  executeOutside(await recipient.build().register().execute());

  // Sender sets up channel to recipient
  executeOutside(await sender.build().setup(recipientAddress).execute());

  let channel = (await sender.discoverChannels([recipientAddress])).channels.get(recipientAddress)!;
  const registry = createEmptyRegistry();
  registry.channels.set(recipientAddress, channel);

  executeOutside(await sender.build({ registry }).with(token).setup(recipientAddress).execute());

  // Refresh channel to include token info
  channel = (await sender.discoverChannels([recipientAddress])).channels.get(recipientAddress)!;
  registry.channels.set(recipientAddress, channel);

  return registry;
}

// Re-export commonly used utilities
export { createEmptyRegistry };
