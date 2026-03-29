import { describe, it, expect, beforeAll } from "vitest";
import {
  Account,
  RpcProvider,
  OutsideExecutionVersion,
  type constants,
  type OutsideExecutionOptions,
} from "starknet";
import { IndexerDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
  SetupRequirement,
} from "@starkware-libs/starknet-privacy-sdk";
import { declarePoolClass } from "../../src/harness.js";

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
  admin?: boolean;
}

const RPC = requireEnv("VITE_RPC_URL");
const INDEXER_URL = requireEnv("VITE_INDEXER_URL");
const TOKEN = requireEnv("VITE_TOKEN_ADDRESS");
const CHAIN_ID = requireEnv("VITE_CHAIN_ID") as constants.StarknetChainId;
const COMPLIANCE_PUBLIC_KEY = requireEnv("VITE_COMPLIANCE_PUBLIC_KEY");
const PROVING_SERVICE_URL = requireEnv("VITE_PROVING_SERVICE_URL");
const accounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));
function findAccount(name: string): AccountEntry {
  const entry = accounts.find(
    (account) => account.name.toLowerCase() === name.toLowerCase(),
  );
  if (!entry)
    throw new Error(`Account "${name}" not found in ACCOUNTS env var`);
  return entry;
}
function findAdmin(): AccountEntry {
  const entry = accounts.find((a) => a.admin);
  if (!entry)
    throw new Error("No admin account (admin: true) found in ACCOUNTS");
  return entry;
}
const admin = findAdmin();
const alice = findAccount("alice");

describe("Privacy StarkNet integration", () => {
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

    // Verify RPC connectivity before proceeding
    console.log("[debug] RPC endpoint:", RPC);
    try {
      const chainId = await provider.getChainId();
      console.log("[debug] RPC connected, chain:", chainId);
    } catch (error) {
      console.error("[debug] RPC connectivity failed:", RPC, error);
      throw error;
    }

    // Declare the contract class (no-op if already declared), then deploy
    const poolClassHash = await declarePoolClass(adminAccount);

    const deploymentSalt = `0x${Date.now().toString(16)}`;
    const constructorCalldata = [admin.address, COMPLIANCE_PUBLIC_KEY, "450"];
    console.log(
      "[debug] deploying fresh privacy pool with salt:",
      deploymentSalt,
    );

    console.log("[debug] estimating deploy fee...");
    const deployFee = await adminAccount.estimateDeployFee({
      classHash: poolClassHash,
      constructorCalldata,
      salt: deploymentSalt,
    });
    console.log("[debug] deploy fee estimated, submitting tx...");
    const deployResult = await adminAccount.deployContract(
      {
        classHash: poolClassHash,
        constructorCalldata,
        salt: deploymentSalt,
      },
      {
        tip: 100n,
        resourceBounds: deployFee.resourceBounds,
      },
    );
    console.log("[debug] deploy tx submitted:", deployResult.transaction_hash);
    console.log("[debug] waiting for deploy receipt...");
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

    discovery = new IndexerDiscoveryProvider(INDEXER_URL, poolAddress);
  }, 300_000);

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
    const log = (msg: string) =>
      console.log(`[${new Date().toISOString()}] ${msg}`);

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
    log("estimating mint fee...");
    const mintCall = {
      contractAddress: TOKEN,
      entrypoint: "permissionedMint",
      calldata: [alice.address, "100", "0"],
    };
    const mintFee = await adminAccount.estimateInvokeFee(mintCall);
    log("submitting mint tx...");
    const mintTx = await adminAccount.execute(mintCall, {
      tip: 10_000n,
      resourceBounds: mintFee.resourceBounds,
    });
    log(`mint tx: ${mintTx.transaction_hash}, waiting...`);
    const mintReceipt = await provider.waitForTransaction(
      mintTx.transaction_hash,
    );
    log(`mint ${mintReceipt.isSuccess() ? "OK" : "FAILED"}`);

    // Approve pool to spend Alice's tokens
    log("estimating approve fee...");
    const approveCall = {
      contractAddress: TOKEN,
      entrypoint: "approve",
      calldata: [poolAddress, "100", "0"],
    };
    const approveFee = await aliceAccount.estimateInvokeFee(approveCall);
    log("submitting approve tx...");
    const approveTx = await aliceAccount.execute(approveCall, {
      tip: 10_000n,
      resourceBounds: approveFee.resourceBounds,
    });
    log(`approve tx: ${approveTx.transaction_hash}, waiting...`);
    const approveReceipt = await provider.waitForTransaction(
      approveTx.transaction_hash,
    );
    log(`approve ${approveReceipt.isSuccess() ? "OK" : "FAILED"}`);

    // Deposit 100 tokens — SDK checks state internally and registers if needed
    const latestBlockNumber = await provider.getBlockNumber();
    const provingBlockId = latestBlockNumber - 10;
    log(
      `building deposit: block=${latestBlockNumber}, provingBlock=${provingBlockId}`,
    );
    const { callAndProof } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(TOKEN, (t) => t.deposit({ amount: 100n }))
      .surplusTo(alice.address)
      .execute({ provingBlockId });
    log(
      `SDK execute() done, proofFacts=${callAndProof.proof.proofFacts?.length ?? 0} elements`,
    );

    // Save proof data for isolated testing
    const { writeFileSync } = await import("fs");
    writeFileSync(
      "/tmp/proof-debug.json",
      JSON.stringify(
        {
          proofFacts: callAndProof.proof.proofFacts,
          proof: callAndProof.proof.data,
          call: callAndProof.call,
          poolAddress,
          adminAddress: admin.address,
          aliceAddress: alice.address,
        },
        null,
        2,
      ),
    );
    log("saved proof data to /tmp/proof-debug.json");

    // Submit via outside execution (admin submits on behalf of Alice).
    const now_seconds = Math.floor(Date.now() / 1000);
    const callOptions: OutsideExecutionOptions = {
      caller: admin.address,
      execute_after: now_seconds - 3600,
      execute_before: now_seconds + 3600,
    };
    log("building outside transaction...");
    const outsideTransaction = await aliceAccount.getOutsideTransaction(
      callOptions,
      callAndProof.call,
      OutsideExecutionVersion.V2,
    );
    log("submitting executeFromOutside (fee estimation + proof)...");
    const executeTx = await adminAccount.executeFromOutside(
      outsideTransaction,
      {
        tip: 10_000n,
        proofFacts: callAndProof.proof.proofFacts,
        proof: callAndProof.proof.data,
      },
    );
    log(`executeFromOutside tx: ${executeTx.transaction_hash}, waiting...`);
    const receipt = await provider.waitForTransaction(
      executeTx.transaction_hash,
    );
    log(`receipt: ${receipt.isSuccess() ? "SUCCESS" : "REVERTED"}`);
    if (!receipt.isSuccess()) {
      console.error("Transaction reverted:", JSON.stringify(receipt, null, 2));
    }
    expect(receipt.isSuccess()).toBe(true);
  }, 300_000);
});
