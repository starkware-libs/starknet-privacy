/**
 * Devnet testing utilities
 *
 * Provides a managed Starknet devnet instance with predeployed contracts
 * and accounts for integration testing.
 */

import {
  Account,
  CairoAssembly,
  CompiledContract,
  constants,
  Contract,
  DeclareContractPayload,
  DeclareContractResponse,
  EDataAvailabilityMode,
  ETransactionVersion,
  extractContractHashes,
  hash,
  isSierra,
  OutsideExecutionOptions,
  OutsideExecutionVersion,
  RpcProvider,
  stark,
  UniversalDetails,
  waitForTransactionOptions,
  type GetTransactionReceiptResponse,
} from "starknet";
import { TracingRpcProvider } from "./tracing-provider.js";
import type { CallAndProof, PrivateTransfersInterface } from "../interfaces.js";
import { createPrivateTransfers } from "../factory.js";
import { CallMockProofProvider } from "./mock-proving.js";
import {
  ContractDiscoveryProvider,
  type DiscoveryOptions,
} from "../internal/contract-discovery.js";
import { toBigInt } from "../utils/crypto.js";
import { Devnet as StarknetDevnet } from "starknet-devnet";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { PrivacyPoolABI } from "../internal/abi.js";
import type { PrivacyPoolContract } from "../internal/private-transfers.js";
import { debugLog } from "../utils/logging.js";
import { AddressMap } from "../utils/maps.js";
import assert from "assert";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Contract paths
const CONTRACT_CLASS_PATH = join(
  __dirname,
  "../../../target/dev/privacy_Privacy.contract_class.json"
);
const COMPILED_CONTRACT_PATH = join(
  __dirname,
  "../../../target/dev/privacy_Privacy.compiled_contract_class.json"
);

// Resource bounds for devnet transactions
// These values are high enough for large contracts but within devnet account balance
const DEVNET_RESOURCE_BOUNDS = {
  l1_gas: {
    max_amount: 10_000_000_000n,
    max_price_per_unit: 1n, // 100 gwei
  },
  l2_gas: {
    max_amount: 10_000_000_000n,
    max_price_per_unit: 1n, // 100 gwei
  },
  l1_data_gas: {
    max_amount: 10_000_000_000n,
    max_price_per_unit: 1n, // 0.1 gwei
  },
};

export interface DevnetConfig {
  /** Number of predeployed user accounts (excludes admin). Default: 2 (alice, bob). */
  userAccounts?: number;
}

export interface DevnetEnvironment {
  alice: Account;
  bob: Account;
  admin: Account;
  /** Extra user accounts beyond alice and bob (index 0 = 3rd user, etc.) */
  extraAccounts: Account[];
  strk: string;
  eth: string;
  privacy: PrivacyPoolContract;
  provider: RpcProvider;
}

/**
 * Declare a contract without calling getStarknetVersion (see https://github.com/starknet-io/starknet.js/issues/1561)
 * Requires compiledClassHash to be provided in the payload
 */
async function declareWithoutVersionCheck(
  account: Account,
  payload: DeclareContractPayload,
  details: UniversalDetails = {}
): Promise<DeclareContractResponse> {
  assert(isSierra(payload.contract), "Contract is not a Sierra contract");

  assert(payload.compiledClassHash, "compiledClassHash is required to skip version check");

  const declareContractPayload = extractContractHashes(payload, undefined);

  const accountInvocations = await account.accountInvocationsFactory(
    [{ type: "DECLARE", payload: declareContractPayload }],
    {
      ...stark.v3Details(details),
      versions: [ETransactionVersion.V3],
      nonce: details.nonce,
      skipValidate: false,
    }
  );

  const declaration = accountInvocations[0];

  return account.declareContract(
    {
      senderAddress: declaration.senderAddress,
      signature: declaration.signature,
      contract: declaration.contract,
      compiledClassHash: declaration.compiledClassHash,
    },
    {
      ...stark.v3Details(details),
      nonce: declaration.nonce,
      resourceBounds: declaration.resourceBounds,
      version: declaration.version,
    }
  );
}

export class Devnet {
  private devnet?: StarknetDevnet;
  private provider?: RpcProvider;
  public setup?: DevnetEnvironment;
  private accountNonces = new AddressMap<number>(() => 0);
  private config: Required<DevnetConfig>;

  constructor(config?: DevnetConfig) {
    this.config = { userAccounts: Math.max(config?.userAccounts ?? 2, 2) };
  }

  /** HTTP RPC URL of the running devnet (e.g. `http://127.0.0.1:5050`). */
  get url(): string {
    if (!this.devnet) throw new Error("Devnet not initialized");
    return this.devnet.provider.url;
  }

  /** WebSocket URL of the running devnet (e.g. `ws://127.0.0.1:5050/ws`). */
  get wsUrl(): string {
    return this.url.replace(/^http/, "ws") + "/ws";
  }

  /**
   * Initialize the devnet environment and deploy all contracts
   */
  async initialize(): Promise<DevnetEnvironment> {
    // Build devnet args
    const devnetArgs = [
      "--lite-mode",
      "--seed",
      "42", // Use a seed for reproducible predeployed accounts
      "--block-generation-on",
      "transaction", // Generate blocks immediately on transaction
      "--state-archive-capacity",
      "full", // Required for block hash computation (proof_facts validation)
      "--accounts",
      String(this.config.userAccounts + 1), // user accounts + admin
      "--l2-gas-price-fri",
      "1",
      "--data-gas-price-fri",
      "1",
      "--gas-price-fri",
      "1",
      "--dump-on",
      "request", // Enable devnet_dump RPC (no-op unless explicitly called)
    ];

    // Spawn a devnet instance on a random free port using the system-installed binary
    this.devnet = await StarknetDevnet.spawnInstalled({
      args: devnetArgs,
    });

    console.log(`Devnet running at: ${this.devnet.provider.url}`);

    // Create a TracingRpcProvider for enhanced error debugging
    this.provider = new TracingRpcProvider({
      nodeUrl: this.devnet.provider.url,
      transactionRetryIntervalFallback: 50,
      batch: 0,
      chainId: "0x534e5f5345504f4c4941",
    });
    this.provider.channel.getStarknetVersion = async () => "0.14.1"; // TODO:
    //(this.provider as any).chainId =

    // Get predeployed accounts using JSON-RPC directly
    const response = await fetch(this.devnet.provider.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "devnet_getPredeployedAccounts",
      }),
    });

    const result = await response.json();
    const accounts = result.result as Array<{
      address: string;
      private_key: string;
      public_key: string;
    }>;

    // Create user accounts (alice, bob, and any extra)
    const userAccounts: Account[] = [];
    for (let i = 0; i < this.config.userAccounts; i++) {
      const raw = accounts[i];
      const keyBytes = new Uint8Array(
        raw.private_key
          .replace("0x", "")
          .match(/.{1,2}/g)!
          .map((byte) => parseInt(byte, 16))
      );
      userAccounts.push(
        new Account({ provider: this.provider, address: raw.address, signer: keyBytes })
      );
    }
    const [alice, bob] = userAccounts;

    // Admin is always the last predeployed account
    const adminRaw = accounts[this.config.userAccounts];
    const adminKeyBytes = new Uint8Array(
      adminRaw.private_key
        .replace("0x", "")
        .match(/.{1,2}/g)!
        .map((byte) => parseInt(byte, 16))
    );
    const admin = this.wrapAccount(
      new Account({
        provider: this.provider,
        address: adminRaw.address,
        signer: adminKeyBytes,
        cairoVersion: "1",
      })
    );

    // Predeployed ERC20 addresses (from devnet output)
    const eth = "0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
    const strk = "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

    // Load contract files
    const contractClass = JSON.parse(readFileSync(CONTRACT_CLASS_PATH, "utf8"));
    const compiledContract = JSON.parse(readFileSync(COMPILED_CONTRACT_PATH, "utf8"));

    // Deploy the privacy pool contract
    const privacy = await this.deployPrivacyContract(admin, contractClass, compiledContract);

    // Pad devnet with empty blocks so block numbers exceed the blockifier's
    // STORED_BLOCK_HASH_BUFFER (10), required for proof_facts validation.
    for (let blockIndex = 0; blockIndex < 10; blockIndex++) {
      await fetch(this.devnet.provider.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock" }),
      });
    }

    this.setup = {
      alice,
      bob,
      admin,
      extraAccounts: userAccounts.slice(2),
      strk,
      eth,
      privacy,
      provider: this.provider,
    };

    debugLog("devnet", "initialize", () =>
      Object.entries(this.setup!)
        .filter(([, value]) => value && typeof value === "object" && "address" in value)
        .map(([key, value]) => `${key}: ${value.address}`)
        .join("\n")
    );

    return this.setup;
  }

  /**
   * Wrap an account with devnet-specific behavior:
   * - Automatic nonce management (local increment instead of network fetch)
   * - Fixed max_fee and tip for faster transaction submission
   */
  private wrapAccount(account: Account): Account {
    const address = account.address;

    return new Proxy(account, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);

        switch (prop) {
          case "declare":
          case "deploy":
          case "deployContract":
          case "execute":
            return async (
              payload: unknown,
              transactionsDetail?: UniversalDetails & waitForTransactionOptions
            ) => {
              const currentNonce = this.accountNonces.get(address)!;

              const details: UniversalDetails & waitForTransactionOptions = {
                nonce: currentNonce,
                resourceBounds: DEVNET_RESOURCE_BOUNDS,
                tip: 0,
                skipValidate: true,
                retryInterval: 50,
                feeDataAvailabilityMode: EDataAvailabilityMode.L2,
                nonceDataAvailabilityMode: EDataAvailabilityMode.L2,
                version: ETransactionVersion.V3,
                ...transactionsDetail,
              };

              debugLog("devnet", "account", `${prop} with nonce ${currentNonce}`);
              this.accountNonces.set(address, currentNonce + 1);

              return prop === "declare"
                ? declareWithoutVersionCheck(target, payload as DeclareContractPayload, details)
                : value.call(target, payload, details);
            };
            break;
          //case "getChainId":
          //  return async () => "0x534e5f5345504f4c4941";
          default:
            break;
        }

        return value;
      },
    });
  }

  /**
   * Deploy the privacy pool contract
   */
  private async deployPrivacyContract(
    deployer: Account,
    contractClass: CompiledContract,
    compiledContract: CairoAssembly
  ): Promise<PrivacyPoolContract> {
    debugLog("devnet", "setup", "Deploying privacy contract");
    // Declare the contract class
    const declareResponse = await deployer.declare({
      contract: contractClass,
      casm: compiledContract,
      compiledClassHash: hash.computeCompiledClassHash(compiledContract),
    });

    const classHash = declareResponse.class_hash;
    debugLog("devnet", "setup", "class hash:", classHash);

    // Deploy the contract
    // Constructor params: governance_admin, auditor_public_key, proof_validity_blocks
    const deployResponse = await deployer.deployContract(
      {
        classHash,
        constructorCalldata: [
          deployer.address, // governance_admin
          "0x1", // auditor_public_key (dummy value)
          "450", // proof_validity_blocks (~15 min at 2s/block)
        ],
        salt: "0x0", // Deterministic salt for reproducible contract address
      },
      { retryInterval: 100 }
    );
    debugLog("devnet", "setup", "deployResponse:", deployResponse);

    const poolContractAddress = deployResponse.contract_address;
    debugLog("devnet", "setup", "Privacy contract deployed at:", poolContractAddress);

    // Create typed contract instance
    const contract = new Contract({
      abi: PrivacyPoolABI,
      address: poolContractAddress,
      providerOrAccount: deployer,
    }).typedv2(PrivacyPoolABI);

    return contract as PrivacyPoolContract;
  }

  /**
   * Execute a call via outside execution using the admin account.
   * The admin creates the outside transaction and executes it.
   * This simulates a paymaster flow.
   */
  async executeOutside(callAndProof: CallAndProof): Promise<GetTransactionReceiptResponse> {
    if (!this.setup) {
      throw new Error("Devnet not initialized");
    }

    const now_seconds = Math.floor(Date.now() / 1000);
    const callOptions: OutsideExecutionOptions = {
      caller: this.setup.admin.address,
      execute_after: now_seconds - 3600,
      execute_before: now_seconds + 3600,
    };

    const outsideTransaction = await this.setup.admin.getOutsideTransaction(
      callOptions,
      callAndProof.call,
      OutsideExecutionVersion.V2
    );

    const response = await this.setup.admin.executeFromOutside(outsideTransaction, {
      proofFacts: callAndProof.proof.proofFacts,
    });
    return this.provider!.waitForTransaction(response.transaction_hash);
  }

  /**
   * Terminate the devnet process.
   */
  async cleanup(): Promise<void> {
    if (this.devnet) {
      this.devnet.kill("SIGINT");
    }
  }
}

/**
 * Test environment for Devnet - mirrors MockTestEnv structure.
 */
export interface DevnetTestEnv {
  devnet: Devnet;
  env: DevnetEnvironment;
  transfers: {
    alice: PrivateTransfersInterface;
    bob: PrivateTransfersInterface;
  };
}

/**
 * Configuration for createDevnetTestEnv.
 */
export interface DevnetTestEnvConfig {
  /** Devnet configuration (account count, etc.) */
  devnet?: DevnetConfig;
  /** Options for discovery (rate limiting, etc.) */
  discoveryOptions?: DiscoveryOptions;
}

/**
 * Create a complete test environment with initialized devnet, accounts, and transfers.
 * This is the recommended way for SDK consumers to set up integration tests.
 *
 * @param devnet - The Devnet instance (must be created by caller for cleanup control)
 * @param config - Optional configuration for the test environment
 * @returns DevnetTestEnv with devnet, env, and transfers
 */
export async function createDevnetTestEnv(
  devnet: Devnet,
  config?: DevnetTestEnvConfig
): Promise<DevnetTestEnv> {
  const env = await devnet.initialize();
  const chainId = constants.StarknetChainId.SN_SEPOLIA;

  const transfers = {
    alice: createPrivateTransfers({
      account: env.alice,
      viewingKeyProvider: { getViewingKey: async () => toBigInt("0xA11CE") },
      provingProvider: new CallMockProofProvider(env.provider, chainId),
      discoveryProvider: new ContractDiscoveryProvider(env.privacy, config?.discoveryOptions),
      poolContractAddress: env.privacy.address,
    }),
    bob: createPrivateTransfers({
      account: env.bob,
      viewingKeyProvider: { getViewingKey: async () => toBigInt("0xB0B") },
      provingProvider: new CallMockProofProvider(env.provider, chainId),
      discoveryProvider: new ContractDiscoveryProvider(env.privacy, config?.discoveryOptions),
      poolContractAddress: env.privacy.address,
    }),
  };

  return { devnet, env, transfers };
}
