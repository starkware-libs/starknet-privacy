/**
 * Vitest global setup for integration tests - runs once before all tests.
 * Starts devnet, declares contracts, and provides context to tests.
 * Note: Contracts are only declared here, deployment happens in individual tests.
 */

import { Devnet } from "starknet-devnet";
import {
  RpcProvider,
  Account,
  json,
  type CompiledSierra,
  type CairoAssembly,
  type waitForTransactionOptions,
} from "starknet";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// Fast polling options for devnet (local network responds quickly)
export const DEVNET_TX_OPTIONS: waitForTransactionOptions = {
  retryInterval: 100,
};

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to compiled contract artifacts
const PRIVACY_CONTRACTS_PATH = path.join(__dirname, "../../target/dev");
const PRIVACY_SIERRA_PATH = path.join(
  PRIVACY_CONTRACTS_PATH,
  "privacy_Privacy.contract_class.json"
);
const PRIVACY_CASM_PATH = path.join(
  PRIVACY_CONTRACTS_PATH,
  "privacy_Privacy.compiled_contract_class.json"
);

const TEST_CONTRACTS_PATH = path.join(__dirname, "../../packages/test_contracts/compiled");
const ECHO_SIERRA_PATH = path.join(TEST_CONTRACTS_PATH, "test_contracts_Echo.contract_class.json");
const ECHO_CASM_PATH = path.join(
  TEST_CONTRACTS_PATH,
  "test_contracts_Echo.compiled_contract_class.json"
);

/**
 * Serializable test context that can be shared via provide/inject.
 * Contains class hashes instead of deployed contract addresses.
 */
export interface SerializableTestContext {
  nodeUrl: string;
  accountAddress: string;
  accountPrivateKey: string;
  privacyClassHash: string;
  privacyAbiJson: string;
  echoClassHash: string;
  echoAbiJson: string;
}

// Declare the injection type for vitest
declare module "vitest" {
  export interface ProvidedContext {
    testContext: SerializableTestContext;
  }
}

let devnet: Devnet | null = null;

export default async function setup({ provide }: { provide: <T>(key: string, value: T) => void }) {
  // Spawn devnet
  devnet = await Devnet.spawnVersion("latest", {
    args: ["--seed", "0"],
  });

  const nodeUrl = devnet.provider.url;
  const provider = new RpcProvider({ nodeUrl });

  // Get predeployed account
  const predeployedAccounts = await devnet.provider.getPredeployedAccounts();
  const predeployed = predeployedAccounts[0];
  const account = new Account({
    provider,
    address: predeployed.address,
    signer: predeployed.private_key,
  });

  // Load contract artifacts
  const privacySierra = json.parse(fs.readFileSync(PRIVACY_SIERRA_PATH, "utf-8")) as CompiledSierra;
  const privacyCasm = json.parse(fs.readFileSync(PRIVACY_CASM_PATH, "utf-8")) as CairoAssembly;
  const echoSierra = json.parse(fs.readFileSync(ECHO_SIERRA_PATH, "utf-8")) as CompiledSierra;
  const echoCasm = json.parse(fs.readFileSync(ECHO_CASM_PATH, "utf-8")) as CairoAssembly;

  // Declare contracts (no deployment)
  const privacyDeclare = await account.declare(
    { contract: privacySierra, casm: privacyCasm },
    { tip: 1000n }
  );
  await provider.waitForTransaction(privacyDeclare.transaction_hash, DEVNET_TX_OPTIONS);

  const echoDeclare = await account.declare(
    { contract: echoSierra, casm: echoCasm },
    { tip: 1000n }
  );
  await provider.waitForTransaction(echoDeclare.transaction_hash, DEVNET_TX_OPTIONS);

  // Provide serializable context to tests (class hashes, not deployed addresses)
  provide("testContext", {
    nodeUrl,
    accountAddress: predeployed.address,
    accountPrivateKey: predeployed.private_key,
    privacyClassHash: privacyDeclare.class_hash,
    privacyAbiJson: JSON.stringify(privacySierra.abi),
    echoClassHash: echoDeclare.class_hash,
    echoAbiJson: JSON.stringify(echoSierra.abi),
  });

  // Return teardown function
  return () => {
    devnet?.kill();
  };
}
