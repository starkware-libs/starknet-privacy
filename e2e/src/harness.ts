import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { constants, hash, type Account } from "starknet";
import {
  Devnet,
  type DevnetEnvironment,
  CallMockProofProvider,
  IndexerDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  createPrivateTransfers,
  type PrivateTransfersInterface,
} from "@starkware-libs/starknet-privacy-sdk";
import { IndexerClient, type IndexerSpawnConfig } from "./indexer-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");

const CONTRACT_CLASS_PATH = join(
  repoRoot,
  "target/release/privacy_Privacy.contract_class.json",
);
const COMPILED_CONTRACT_PATH = join(
  repoRoot,
  "target/release/privacy_Privacy.compiled_contract_class.json",
);

/**
 * Declare the privacy pool contract class on-chain.
 * Loads sierra + casm artifacts from target/release/, computes the class hash,
 * and submits DECLARE if not already declared. Returns the class hash.
 */
export async function declarePoolClass(
  adminAccount: Account,
  resourceBounds?: {
    l2_gas: { max_amount: bigint; max_price_per_unit: bigint };
    l1_gas: { max_amount: bigint; max_price_per_unit: bigint };
    l1_data_gas: { max_amount: bigint; max_price_per_unit: bigint };
  },
): Promise<string> {
  const contractClass = JSON.parse(readFileSync(CONTRACT_CLASS_PATH, "utf8"));
  const compiledContract = JSON.parse(
    readFileSync(COMPILED_CONTRACT_PATH, "utf8"),
  );
  const classHash = hash.computeContractClassHash(contractClass);

  try {
    await adminAccount.getClass(classHash);
    console.log("[declare] class already declared:", classHash);
    return classHash;
  } catch {
    // Not declared yet — proceed
  }

  console.log("[declare] submitting DECLARE for class hash:", classHash);
  const response = await adminAccount.declare(
    { contract: contractClass, casm: compiledContract },
    { tip: 0n, ...(resourceBounds ? { resourceBounds } : {}) },
  );
  const receipt = await adminAccount.waitForTransaction(
    response.transaction_hash,
  );
  if (!receipt.isSuccess()) {
    throw new Error(`DECLARE failed: ${JSON.stringify(receipt, null, 2)}`);
  }
  console.log("[declare] class declared successfully:", classHash);
  return classHash;
}

export interface E2eTestEnv {
  devnet: Devnet;
  env: DevnetEnvironment;
  transfers: {
    alice: PrivateTransfersInterface;
    bob: PrivateTransfersInterface;
  };
  indexer: IndexerClient;
}

export interface E2eTestEnvConfig {
  indexer?: Partial<IndexerSpawnConfig>;
}

export async function createE2eTestEnv(
  devnet: Devnet,
  config?: E2eTestEnvConfig,
): Promise<E2eTestEnv> {
  const env = await devnet.initialize();
  const chainId = constants.StarknetChainId.SN_SEPOLIA;

  const indexer = await IndexerClient.spawn({
    wsUrl: devnet.wsUrl,
    rpcUrl: devnet.url,
    ...config?.indexer,
  });
  await indexer.waitUntilReady(devnet.url);

  const transfers = {
    alice: createPrivateTransfers({
      account: env.alice,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(env.provider, chainId),
      discoveryProvider: new IndexerDiscoveryProvider(
        indexer.apiUrl,
        env.privacy.address,
      ),
      poolContractAddress: env.privacy.address,
    }),
    bob: createPrivateTransfers({
      account: env.bob,
      viewingKeyProvider: { getViewingKey: async () => BigInt("0xB0B") },
      provingProvider: new CallMockProofProvider(env.provider, chainId),
      discoveryProvider: new IndexerDiscoveryProvider(
        indexer.apiUrl,
        env.privacy.address,
      ),
      poolContractAddress: env.privacy.address,
    }),
  };

  return { devnet, env, transfers, indexer };
}
