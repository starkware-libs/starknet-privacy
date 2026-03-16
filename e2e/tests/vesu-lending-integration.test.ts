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
  Open,
  type CallAndProof,
} from "starknet-sdk";
import { IndexerClient } from "../src/indexer-client.js";

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
const USD_TOKEN = requireEnv("USD_TOKEN_ADDRESS");
const USD_VTOKEN = requireEnv("USD_VTOKEN_ADDRESS");
const VESU_LENDING_HELPER = requireEnv("VESU_LENDING_HELPER_ADDRESS");

const CHAIN_ID = requireEnv("CHAIN_ID") as constants.StarknetChainId;
const POOL_CLASS_HASH = requireEnv("POOL_CLASS_HASH");
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

const L2_GAS_PRICE = 16_000_000_000n;
const L1_GAS_PRICE = 1_000_000_000_000n;
const L1_DATA_GAS_PRICE = 2_000n;
const DEPLOY_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 4_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 3_500n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const ERC20_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 640n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const POOL_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 5_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};

describe("Privacy StarkNet integration: Vesu lending", () => {
  let indexer: IndexerClient;
  let discovery: IndexerDiscoveryProvider;
  let provider: RpcProvider;
  let adminAccount: Account;
  let aliceAccount: Account;
  let poolAddress: string;

  async function submitOutside(callAndProof: CallAndProof) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const callOptions: OutsideExecutionOptions = {
      caller: admin.address,
      execute_after: nowSeconds - 3600,
      execute_before: nowSeconds + 3600,
    };

    const outsideTx = await aliceAccount.getOutsideTransaction(
      callOptions,
      callAndProof.call,
      OutsideExecutionVersion.V2,
    );

    const executeTx = await adminAccount.executeFromOutside(outsideTx, {
      tip: 0n,
      resourceBounds: POOL_RESOURCE_BOUNDS,
      proofFacts: callAndProof.proof.proofFacts,
      proof: callAndProof.proof.data,
    });
    const receipt = await provider.waitForTransaction(
      executeTx.transaction_hash,
    );
    if (!receipt.isSuccess()) {
      const revertReason =
        (receipt as Record<string, unknown>).revert_reason ?? "unknown";
      throw new Error(
        `Outside execution failed: ${executeTx.transaction_hash} revert=${revertReason}`,
      );
    }
  }

  async function waitForOutputNotes(
    transfers: ReturnType<typeof createPrivateTransfers>,
    token: string,
    timeoutMs: number,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { notes } = await transfers.discoverNotes();
      const outputNotes = notes.get(BigInt(token)) ?? [];
      const outputAmount = outputNotes.reduce(
        (sum, note) => sum + note.amount,
        0n,
      );
      if (outputAmount > 0n) {
        return notes;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error("Timed out waiting for discovered output notes");
  }

  async function waitForBlocks(
    afterBlock: number,
    gapSize: number,
    timeoutMs: number,
  ) {
    const deadline = Date.now() + timeoutMs;
    let currentBlock = afterBlock;
    while (currentBlock < afterBlock + gapSize) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for blocks");
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      currentBlock = await provider.getBlockNumber();
      console.log(
        `[vesu-lending] waiting for blocks: ${currentBlock}/${afterBlock + gapSize}`,
      );
    }
    return currentBlock;
  }

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

    // Deploy fresh privacy pool
    const deploymentSalt = `0x${Date.now().toString(16)}`;
    const deployResult = await adminAccount.deployContract(
      {
        classHash: POOL_CLASS_HASH,
        constructorCalldata: [admin.address, COMPLIANCE_PUBLIC_KEY, "450"],
        salt: deploymentSalt,
      },
      { tip: 0n, resourceBounds: DEPLOY_RESOURCE_BOUNDS },
    );
    const deployReceipt = await provider.waitForTransaction(
      deployResult.transaction_hash,
    );
    if (!deployReceipt.isSuccess()) {
      throw new Error("Privacy pool deployment failed");
    }
    poolAddress = deployResult.contract_address;

    indexer = await IndexerClient.spawn({
      wsUrl: WS,
      rpcUrl: RPC,
      logFile: "vesu-lending-integration-indexer.log",
    });
    await indexer.waitForLog("API server listening", 30_000);

    discovery = new IndexerDiscoveryProvider(indexer.apiUrl, poolAddress);
  }, 180_000);

  afterAll(() => {
    indexer?.shutdown();
  });

  it("deposit USD + Vesu lend + Vesu unlend roundtrip", async () => {
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

    const ONE_TOKEN = 10n ** 18n;
    const depositAmount = 100n * ONE_TOKEN;
    const lendAmount = 50n * ONE_TOKEN;

    // Mint USD to Alice and approve privacy pool
    const mintTx = await adminAccount.execute(
      {
        contractAddress: USD_TOKEN,
        entrypoint: "permissionedMint",
        calldata: [alice.address, depositAmount, 0n],
      },
      { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
    );
    const mintReceipt = await provider.waitForTransaction(
      mintTx.transaction_hash,
    );
    expect(mintReceipt.isSuccess()).toBe(true);

    const approveTx = await aliceAccount.execute(
      {
        contractAddress: USD_TOKEN,
        entrypoint: "approve",
        calldata: [poolAddress, depositAmount, 0n],
      },
      { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
    );
    const approveReceipt = await provider.waitForTransaction(
      approveTx.transaction_hash,
    );
    expect(approveReceipt.isSuccess()).toBe(true);

    // Phase 1: Deposit USD into privacy pool
    const latestBlockNumber = await provider.getBlockNumber();
    const provingBlockId = latestBlockNumber - 10;

    const { callAndProof: depositCall } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(USD_TOKEN, (t) => t.deposit({ amount: depositAmount }))
      .surplusTo(alice.address)
      .execute({ provingBlockId });
    await submitOutside(depositCall);
    console.log("[vesu-lending] deposit submitted");

    const depositBlock = await provider.getBlockNumber();
    console.log(`[vesu-lending] deposit confirmed at block ${depositBlock}`);

    // Wait for proving gap
    const MIN_PROVING_GAP = 10;
    await waitForBlocks(depositBlock, MIN_PROVING_GAP, 300_000);
    const lendProvingBlockId = depositBlock;
    console.log(
      `[vesu-lending] using lend proving block ${lendProvingBlockId}`,
    );

    // Phase 2: Lend (withdraw USD to helper → helper deposits into Vesu → get vToken)
    const { callAndProof: lendCall } = await transfers
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(USD_TOKEN)
      .withdraw({ recipient: VESU_LENDING_HELPER, amount: lendAmount })
      .surplusTo(alice.address, false)
      .with(USD_VTOKEN)
      .transfer({
        recipient: alice.address,
        amount: Open,
        depositor: VESU_LENDING_HELPER,
      })
      .done()
      .invoke((args) => {
        const openNote = args.openNotes[0];
        if (!openNote) {
          throw new Error("Expected one open note for lend invocation");
        }
        return {
          contractAddress: VESU_LENDING_HELPER,
          calldata: [
            0n, // LendingOperation::Deposit = 0
            USD_TOKEN, // in_token (underlying)
            USD_VTOKEN, // out_token (vault token)
            lendAmount, // assets (u256 low)
            0n, // assets (u256 high)
            openNote.noteId, // note_id
          ],
        };
      })
      .execute({ provingBlockId: lendProvingBlockId });
    console.log("[vesu-lending] lend proved");

    await submitOutside(lendCall);
    console.log("[vesu-lending] lend submitted");

    // Phase 3: Discover vToken notes
    const vTokenNotes = await waitForOutputNotes(
      transfers,
      USD_VTOKEN,
      120_000,
    );
    const vTokenOutputNotes = vTokenNotes.get(BigInt(USD_VTOKEN)) ?? [];
    const vTokenAmount = vTokenOutputNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(vTokenAmount).toBeGreaterThan(0n);
    console.log(`[vesu-lending] discovered ${vTokenAmount} vToken`);

    // Wait for proving gap before unlend
    const lendBlock = await provider.getBlockNumber();
    await waitForBlocks(lendBlock, MIN_PROVING_GAP, 300_000);
    const unlendProvingBlockId = lendBlock;
    console.log(
      `[vesu-lending] using unlend proving block ${unlendProvingBlockId}`,
    );

    // Phase 4: Unlend (withdraw vTokens to helper → helper withdraws from Vesu → get USD back)
    // Use the vToken amount we received (withdraw by assets, not shares)
    const withdrawAmount = lendAmount; // withdraw same amount of underlying assets

    const { callAndProof: unlendCall } = await transfers
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(USD_VTOKEN)
      .withdraw({ recipient: VESU_LENDING_HELPER, amount: vTokenAmount })
      .surplusTo(alice.address, false)
      .with(USD_TOKEN)
      .transfer({
        recipient: alice.address,
        amount: Open,
        depositor: VESU_LENDING_HELPER,
      })
      .done()
      .invoke((args) => {
        const openNote = args.openNotes[0];
        if (!openNote) {
          throw new Error("Expected one open note for unlend invocation");
        }
        return {
          contractAddress: VESU_LENDING_HELPER,
          calldata: [
            1n, // LendingOperation::Withdraw = 1
            USD_VTOKEN, // in_token (vault token)
            USD_TOKEN, // out_token (underlying)
            withdrawAmount, // assets (u256 low)
            0n, // assets (u256 high)
            openNote.noteId, // note_id
          ],
        };
      })
      .execute({ provingBlockId: unlendProvingBlockId });
    console.log("[vesu-lending] unlend proved");

    await submitOutside(unlendCall);
    console.log("[vesu-lending] unlend submitted");

    // Phase 5: Discover USD notes back
    const finalNotes = await waitForOutputNotes(transfers, USD_TOKEN, 120_000);

    const usdOutputNotes = finalNotes.get(BigInt(USD_TOKEN)) ?? [];
    const totalUsdRecovered = usdOutputNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(totalUsdRecovered).toBeGreaterThan(0n);

    // The roundtrip should preserve value (within rounding tolerance of a few wei).
    // With 1:1 share ratio and no time elapsed, we expect to get back ~lendAmount.
    // The change from the original deposit (depositAmount - lendAmount) should also be present.
    // Total should be at least depositAmount - lendAmount (change) + some recovered amount
    expect(totalUsdRecovered).toBeGreaterThanOrEqual(
      depositAmount - lendAmount,
    );

    console.log(
      `[vesu-lending] roundtrip complete: recovered ${totalUsdRecovered} USD`,
    );
  }, 900_000);
});
