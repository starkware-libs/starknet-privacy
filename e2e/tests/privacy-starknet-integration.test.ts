import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Account,
  RpcProvider,
  OutsideExecutionVersion,
  type constants,
  type OutsideExecutionOptions,
} from "starknet";
import { IndexerDiscoveryProvider } from "starknet-sdk/testing";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
  SetupRequirement,
} from "starknet-sdk";
import { IndexerClient } from "../src/indexer-client.js";
import { declarePoolClass } from "../src/harness.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

interface AccountEntry {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
}

const RPC = requireEnv("RPC_URL");
const WS = requireEnv("WS_URL");
const TOKEN = requireEnv("TOKEN_ADDRESS");
const CHAIN_ID = requireEnv("CHAIN_ID") as constants.StarknetChainId;
const COMPLIANCE_PUBLIC_KEY = requireEnv("COMPLIANCE_PUBLIC_KEY");
const PROVING_SERVICE_URL = requireEnv("VITE_PROVING_SERVICE_URL");
const accounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));
function findAccount(name: string): AccountEntry {
  const entry = accounts.find((account) => account.name === name);
  if (!entry)
    throw new Error(`Account "${name}" not found in ACCOUNTS env var`);
  return entry;
}
const admin = findAccount("admin");
const alice = findAccount("alice");

// Manual resource bounds for integration sepolia (no tip oracle data available).
const L2_GAS_PRICE = 16_000_000_000n;
const L1_GAS_PRICE = 1_000_000_000_000n;
const L1_DATA_GAS_PRICE = 2_000n;
const ERC20_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 640n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const DECLARE_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_500_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 25_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const DEPLOY_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 4_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 3_500n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const POOL_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 5_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

describe("Privacy StarkNet integration", () => {
  let indexer: IndexerClient;
  let discovery: IndexerDiscoveryProvider;
  let provider: RpcProvider;
  let adminAccount: Account;
  let aliceAccount: Account;
  let poolAddress: string;

  beforeAll(async () => {
    provider = new RpcProvider({ nodeUrl: RPC });
    adminAccount = new Account({
      provider,
      address: admin.address,
      signer: admin.privateKey,
      cairoVersion: "1",
    });
    aliceAccount = new Account({
      provider,
      address: alice.address,
      signer: alice.privateKey,
      cairoVersion: "1",
    });

    // Declare the contract class (no-op if already declared), then deploy
    const poolClassHash = await declarePoolClass(
      adminAccount,
      DECLARE_RESOURCE_BOUNDS,
    );

    const deploymentSalt = `0x${Date.now().toString(16)}`;
    const constructorCalldata = [admin.address, COMPLIANCE_PUBLIC_KEY, "450"];
    console.log(
      "[debug] deploying fresh privacy pool with salt:",
      deploymentSalt,
    );

    const deployResult = await adminAccount.deployContract(
      {
        classHash: poolClassHash,
        constructorCalldata,
        salt: deploymentSalt,
      },
      { tip: 0n, resourceBounds: DEPLOY_RESOURCE_BOUNDS },
    );
    const deployReceipt = await provider.waitForTransaction(
      deployResult.transaction_hash,
    );
    if (!deployReceipt.isSuccess()) {
      console.error(
        "[debug] deploy FAILED:",
        JSON.stringify(deployReceipt, null, 2),
      );
      throw new Error("Privacy pool deployment failed");
    }
    poolAddress = deployResult.contract_address;
    console.log("[debug] privacy pool deployed at:", poolAddress);
    console.log("[debug] deploy tx:", deployResult.transaction_hash);

    indexer = await IndexerClient.spawn({
      wsUrl: WS,
      rpcUrl: RPC,
      logFile: "privacy-starknet-integration-indexer.log",
    });
    await indexer.waitForLog("API server listening", 30_000);

    discovery = new IndexerDiscoveryProvider(indexer.apiUrl, poolAddress);
  }, 120_000);

  afterAll(() => {
    indexer?.shutdown();
  });

  it("preflight returns a valid SetupRequirement", async () => {
    const requirement = await discovery.discoverRequirement(
      BigInt(alice.address),
      BigInt(alice.viewingKey),
      BigInt(alice.address),
      BigInt(TOKEN),
    );
    console.log(
      "[debug] preflight requirement:",
      SetupRequirement[requirement],
      `(${requirement})`,
    );
    expect(requirement).toBeGreaterThanOrEqual(SetupRequirement.Register);
    expect(requirement).toBeLessThanOrEqual(SetupRequirement.Ready);
  });

  it("deposit with auto-register", async () => {
    const transfers = createPrivateTransfers({
      account: aliceAccount,
      viewingKeyProvider: {
        getViewingKey: async () => BigInt(alice.viewingKey),
      },
      provingProvider: new ProvingServiceProofProvider(
        PROVING_SERVICE_URL,
        CHAIN_ID,
      ),
      discoveryProvider: discovery,
      poolContractAddress: poolAddress,
    });

    // Mint tokens to Alice (admin is the minter)
    console.log("[debug] minting 100 tokens to alice:", alice.address);
    const mintTx = await adminAccount.execute(
      {
        contractAddress: TOKEN,
        entrypoint: "permissionedMint",
        calldata: [alice.address, "100", "0"],
      },
      { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
    );
    const mintReceipt = await provider.waitForTransaction(
      mintTx.transaction_hash,
    );
    console.log(
      "[debug] mint tx:",
      mintTx.transaction_hash,
      "status:",
      mintReceipt.isSuccess() ? "OK" : "FAILED",
    );

    // Approve pool to spend Alice's tokens
    console.log("[debug] approving pool to spend 100 tokens");
    const approveTx = await aliceAccount.execute(
      {
        contractAddress: TOKEN,
        entrypoint: "approve",
        calldata: [poolAddress, "100", "0"],
      },
      { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
    );
    const approveReceipt = await provider.waitForTransaction(
      approveTx.transaction_hash,
    );
    console.log(
      "[debug] approve tx:",
      approveTx.transaction_hash,
      "status:",
      approveReceipt.isSuccess() ? "OK" : "FAILED",
    );

    // Deposit 100 tokens — SDK checks state internally and registers if needed
    console.log("[debug] building deposit transaction...");
    console.log("[debug] alice address:", alice.address);
    console.log("[debug] pool address:", poolAddress);
    console.log("[debug] token address:", TOKEN);
    const latestBlockNumber = await provider.getBlockNumber();
    const provingBlockId = latestBlockNumber - 10;
    console.log("[debug] latest block number:", latestBlockNumber);
    console.log("[debug] proving block id:", provingBlockId);
    const { callAndProof } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(TOKEN, (t) => t.deposit({ amount: 100n }))
      .surplusTo(alice.address)
      .execute({ provingBlockId });
    console.log("[debug] execute() completed successfully");
    console.log(
      "[debug] ProofFacts:",
      callAndProof.proof.proofFacts
        ? `${callAndProof.proof.proofFacts.length} elements`
        : "undefined",
    );

    // Submit via outside execution (admin submits on behalf of Alice).
    // This is required because proofFacts change the tx hash, and the account
    // contract validates the standard tx hash (without proofFacts) in __validate__.
    const now_seconds = Math.floor(Date.now() / 1000);
    const callOptions: OutsideExecutionOptions = {
      caller: admin.address,
      execute_after: now_seconds - 3600,
      execute_before: now_seconds + 3600,
    };
    const outsideTransaction = await aliceAccount.getOutsideTransaction(
      callOptions,
      callAndProof.call,
      OutsideExecutionVersion.V2,
    );
    const executeTx = await adminAccount.executeFromOutside(
      outsideTransaction,
      {
        tip: 0n,
        resourceBounds: POOL_RESOURCE_BOUNDS,
        proofFacts: callAndProof.proof.proofFacts,
        proof: callAndProof.proof.data,
      },
    );
    const receipt = await provider.waitForTransaction(
      executeTx.transaction_hash,
    );
    if (!receipt.isSuccess()) {
      console.error("Transaction reverted:", JSON.stringify(receipt, null, 2));
    }
    expect(receipt.isSuccess()).toBe(true);
  }, 120_000);
});
