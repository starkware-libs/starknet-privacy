import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "fs";
import {
  Account,
  RpcProvider,
  OutsideExecutionVersion,
  type constants,
  type OutsideExecutionOptions,
  type BigNumberish,
} from "starknet";
import { IndexerDiscoveryProvider } from "starknet-sdk/testing";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
  SetupRequirement,
  type AccountSignerRaw,
  type ProofProviderInterface,
} from "starknet-sdk";
import { IndexerClient } from "../src/indexer-client.js";

const RPC = "http://34.170.239.64:9545/rpc/v0_10";
const WS = "ws://34.170.239.64:9545/ws/rpc/v0_8";
const TOKEN =
  "0x7b19e89252b1ee5d7ff07a0e0e278b16b058f322053f799469b969e31b82969";
const CHAIN_ID =
  "0x534e5f494e544547524154494f4e5f5345504f4c4941" as constants.StarknetChainId;

// Privacy pool class hash (already declared on-chain)
const POOL_CLASS_HASH =
  "0x3121db23aa238a8c03fecb1953b0db6697f0a9e55ff464f46690ef25af2a69e";
const COMPLIANCE_PUBLIC_KEY =
  "0x02fbf66c1dd8c556f8f9ee8852669513a9559385194da39ff0e33ed38586fe47";
const PROVING_SERVICE_URL = process.env.PROVING_SERVICE_URL ?? "http://136.115.124.93:3000";

// Manual resource bounds for integration sepolia (no tip oracle data available).
const L2_GAS_PRICE = 16_000_000_000n;
const L1_GAS_PRICE = 1_000_000_000_000n;
const L1_DATA_GAS_PRICE = 2_000n;
const ERC20_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 640n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const DEPLOY_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 4_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 3_500n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const POOL_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 4_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 1_100n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

function createProvingProvider(
  provider: RpcProvider,
  account: Account,
): ProofProviderInterface {
  return new ProvingServiceProofProvider(
    PROVING_SERVICE_URL,
    provider,
    CHAIN_ID,
    account,
    { requestTimeoutMs: 600_000 },
  );
}

const accountsMap = JSON.parse(
  readFileSync(new URL("../accounts.json", import.meta.url), "utf-8"),
) as Record<string, { address: string; private_key: string }>;
const admin = accountsMap.admin;
const alice = accountsMap.alice;

describe("Privacy StarkNet integration (custom pool)", () => {
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
      signer: admin.private_key,
      cairoVersion: "1",
    });
    aliceAccount = new Account({
      provider,
      address: alice.address,
      signer: alice.private_key,
      cairoVersion: "1",
    });

    // Deploy a fresh privacy pool via UDC (same class hash as integration test)
    const deploymentSalt = `0x${Date.now().toString(16)}`;
    const constructorCalldata = [admin.address, COMPLIANCE_PUBLIC_KEY];
    console.log("[debug] deploying fresh privacy pool with salt:", deploymentSalt);

    const deployResult = await adminAccount.deployContract(
      {
        classHash: POOL_CLASS_HASH,
        constructorCalldata,
        salt: deploymentSalt,
      },
      { tip: 0n, resourceBounds: DEPLOY_RESOURCE_BOUNDS },
    );
    const deployReceipt = await provider.waitForTransaction(deployResult.transaction_hash);
    if (!deployReceipt.isSuccess()) {
      console.error("[debug] deploy FAILED:", JSON.stringify(deployReceipt, null, 2));
      throw new Error("Privacy pool deployment failed");
    }
    poolAddress = deployResult.contract_address;
    console.log("[debug] privacy pool deployed at:", poolAddress);
    console.log("[debug] deploy tx:", deployResult.transaction_hash);

    indexer = await IndexerClient.spawn({
      wsUrl: WS,
      rpcUrl: RPC,
      logFile: "privacy-starknet-custom-pool-indexer.log",
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
      BigInt(alice.private_key),
      BigInt(alice.address),
      BigInt(TOKEN),
    );
    console.log("[debug] preflight requirement:", SetupRequirement[requirement], `(${requirement})`);
    expect(requirement).toBeGreaterThanOrEqual(SetupRequirement.Register);
    expect(requirement).toBeLessThanOrEqual(SetupRequirement.Ready);
  });

  it("deposit to custom pool with proving service", async () => {
    const transfers = createPrivateTransfers({
      account: aliceAccount as unknown as AccountSignerRaw,
      viewingKeyProvider: { getViewingKey: () => BigInt(alice.private_key) },
      provingProvider: createProvingProvider(provider, aliceAccount),
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
    const mintReceipt = await provider.waitForTransaction(mintTx.transaction_hash);
    console.log("[debug] mint tx:", mintTx.transaction_hash, "status:", mintReceipt.isSuccess() ? "OK" : "FAILED");

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
    const approveReceipt = await provider.waitForTransaction(approveTx.transaction_hash);
    console.log("[debug] approve tx:", approveTx.transaction_hash, "status:", approveReceipt.isSuccess() ? "OK" : "FAILED");

    // Deposit 100 tokens — SDK checks state and registers if needed
    console.log("[debug] building deposit transaction...");
    const { callAndProof } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(TOKEN, (t) => t.deposit({ amount: 100n }))
      .surplusTo(alice.address)
      .execute();
    console.log("[debug] execute() completed successfully");

    // Submit via outside execution (admin submits on behalf of Alice) when proofFacts are present,
    // so the account contract's __validate__ sees the standard tx hash.
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
    console.log("[debug] proof facts:", callAndProof.proof.proofFacts);
    console.log("[debug] proof data:", callAndProof.proof.data.slice(0, 50));
    console.log("[debug] proof data type:", typeof callAndProof.proof.data);
    console.log("[debug] proof data length:", callAndProof.proof.data.length);
    // console.log("[debug] proof data casting to BigNumberish:", (callAndProof.proof.data as unknown as BigNumberish[]).slice(0, 50));
    console.log("[debug] outside transaction:", outsideTransaction);
    const executeTx = await adminAccount.executeFromOutside(outsideTransaction, {
      tip: 0n,
      resourceBounds: POOL_RESOURCE_BOUNDS,
      proofFacts: callAndProof.proof.proofFacts,
      proof: callAndProof.proof.data,
    });
    const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
    if (!receipt.isSuccess()) {
      console.error("Transaction reverted:", JSON.stringify(receipt, null, 2));
    }
    expect(receipt.isSuccess()).toBe(true);
  }, 600_000); // 10 min — proving + execute can be slow
});
