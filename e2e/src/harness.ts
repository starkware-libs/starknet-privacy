import { readFileSync } from "fs";
import { join } from "path";
import { constants, hash, type Account } from "starknet";
import { repoRoot } from "./utils.js";
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

const CONTRACT_CLASS_PATH = join(
  repoRoot(),
  "target/release/privacy_Privacy.contract_class.json",
);
const COMPILED_CONTRACT_PATH = join(
  repoRoot(),
  "target/release/privacy_Privacy.compiled_contract_class.json",
);

/**
 * Declare the privacy pool contract class on-chain.
 * Loads sierra + casm artifacts from target/release/, computes the class hash,
 * and submits DECLARE if not already declared. Returns the class hash.
 */
export async function declarePoolClass(adminAccount: Account): Promise<string> {
  const contractClass = JSON.parse(readFileSync(CONTRACT_CLASS_PATH, "utf8"));
  const compiledContract = JSON.parse(
    readFileSync(COMPILED_CONTRACT_PATH, "utf8"),
  );
  const classHash = hash.computeContractClassHash(contractClass);

  try {
    await adminAccount.provider.getClass(classHash);
    console.log("[declare] class already declared:", classHash);
    return classHash;
  } catch (error: unknown) {
    // CLASS_HASH_NOT_FOUND means we need to declare — any other error is unexpected
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("not found") && !message.includes("CLASS_HASH")) {
      console.error("[declare] unexpected error checking class:", message);
      throw error;
    }
  }

  console.log("[declare] estimating declare fee...");
  const declarePayload = { contract: contractClass, casm: compiledContract };
  const feeEstimate = await adminAccount.estimateDeclareFee(declarePayload);

  console.log("[declare] submitting DECLARE for class hash:", classHash);
  let response;
  try {
    response = await adminAccount.declare(declarePayload, {
      tip: 0n,
      resourceBounds: feeEstimate.resourceBounds,
    });
  } catch (error: unknown) {
    // Code 51 = class already declared (race with another tx)
    if (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code: number }).code === 51
    ) {
      console.log("[declare] class already declared:", classHash);
      return classHash;
    }
    // Extract useful info without dumping the full sierra payload
    if (error instanceof Error && "code" in error) {
      const rpcError = error as Error & {
        code: number;
        baseError?: unknown;
      };
      console.error("[declare] RPC error code:", rpcError.code);
      console.error(
        "[declare] RPC error:",
        rpcError.message.split(" with params")[0],
      );
      if (rpcError.baseError)
        console.error("[declare] details:", JSON.stringify(rpcError.baseError));
    } else {
      console.error("[declare] DECLARE failed:", error);
    }
    throw error;
  }
  const receipt = await adminAccount.provider.waitForTransaction(
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

  // Source-built pool: its class hash is never pinned, so force compatibility
  // calldata until the in-repo contract accepts the screening suffix.
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
      poolMode: "compatibility",
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
      poolMode: "compatibility",
    }),
  };

  return { devnet, env, transfers, indexer };
}
