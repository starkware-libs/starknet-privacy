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
const BTC_TOKEN = requireEnv("BTC_TOKEN_ADDRESS");
const EXECUTOR = requireEnv("EXECUTOR_ADDRESS");
const EKUBO_POOL_TOKEN0 = requireEnv("EKUBO_POOL_TOKEN0");
const EKUBO_POOL_TOKEN1 = requireEnv("EKUBO_POOL_TOKEN1");
const EKUBO_POOL_FEE = BigInt(requireEnv("EKUBO_POOL_FEE"));
const EKUBO_TICK_SPACING = BigInt(requireEnv("EKUBO_TICK_SPACING"));
const EKUBO_EXTENSION = requireEnv("EKUBO_EXTENSION");
const EKUBO_SKIP_AHEAD = BigInt(requireEnv("EKUBO_SKIP_AHEAD"));

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

describe("Privacy StarkNet integration: Ekubo swap", () => {
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
      throw new Error(
        `Outside execution failed: ${executeTx.transaction_hash}`,
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
      logFile: "swap-ekubo-integration-indexer.log",
    });
    await indexer.waitForLog("API server listening", 30_000);

    discovery = new IndexerDiscoveryProvider(indexer.apiUrl, poolAddress);
  }, 180_000);

  afterAll(() => {
    indexer?.shutdown();
  });

  it("deposit BTC + swap BTC→USD via Ekubo executor yields USD output note and BTC change note", async () => {
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
    const swapAmount = 10n * ONE_TOKEN;

    const mintTx = await adminAccount.execute(
      {
        contractAddress: BTC_TOKEN,
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
        contractAddress: BTC_TOKEN,
        entrypoint: "approve",
        calldata: [poolAddress, depositAmount, 0n],
      },
      { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
    );
    const approveReceipt = await provider.waitForTransaction(
      approveTx.transaction_hash,
    );
    expect(approveReceipt.isSuccess()).toBe(true);

    const latestBlockNumber = await provider.getBlockNumber();
    const provingBlockId = latestBlockNumber - 10;

    const { callAndProof: depositCall } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(BTC_TOKEN, (t) => t.deposit({ amount: depositAmount }))
      .surplusTo(alice.address)
      .execute({ provingBlockId });
    await submitOutside(depositCall);
    console.log("[ekubo-swap-btc-usd] deposit submitted");

    const depositBlock = await provider.getBlockNumber();
    console.log(
      `[ekubo-swap-btc-usd] deposit confirmed at block ${depositBlock}`,
    );
    const MIN_PROVING_GAP = 10;
    const waitDeadline = Date.now() + 300_000;
    let currentBlock = depositBlock;
    while (currentBlock < depositBlock + MIN_PROVING_GAP) {
      if (Date.now() > waitDeadline) {
        throw new Error("Timed out waiting for blocks after deposit");
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      currentBlock = await provider.getBlockNumber();
      console.log(
        `[ekubo-swap-btc-usd] waiting for blocks: ${currentBlock}/${depositBlock + MIN_PROVING_GAP}`,
      );
    }
    const swapProvingBlockId = depositBlock;
    console.log(
      `[ekubo-swap-btc-usd] using swap proving block ${swapProvingBlockId}`,
    );

    const { callAndProof: swapCall } = await transfers
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(BTC_TOKEN)
      .withdraw({ recipient: EXECUTOR, amount: swapAmount })
      .surplusTo(alice.address, false)
      .with(USD_TOKEN)
      .transfer({
        recipient: alice.address,
        amount: Open,
        depositor: EXECUTOR,
      })
      .done()
      .invoke((args) => {
        const openNote = args.openNotes[0];
        if (!openNote) {
          throw new Error("Expected one open note for swap invocation");
        }
        return {
          contractAddress: EXECUTOR,
          calldata: [
            BTC_TOKEN,
            USD_TOKEN,
            swapAmount,
            openNote.noteId,
            EKUBO_POOL_TOKEN0,
            EKUBO_POOL_TOKEN1,
            EKUBO_POOL_FEE,
            EKUBO_TICK_SPACING,
            EKUBO_EXTENSION,
            0n,
            0n,
            EKUBO_SKIP_AHEAD,
          ],
        };
      })
      .execute({ provingBlockId: swapProvingBlockId });
    console.log("[ekubo-swap-btc-usd] swap proved");

    await submitOutside(swapCall);
    console.log("[ekubo-swap-btc-usd] swap submitted");

    const notes = await waitForOutputNotes(transfers, USD_TOKEN, 120_000);

    const outputNotes = notes.get(BigInt(USD_TOKEN)) ?? [];
    const outputAmount = outputNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(outputAmount).toBeGreaterThan(0n);
    expect(outputNotes.some((note) => note.open && note.amount > 0n)).toBe(
      true,
    );

    const changeNotes = notes.get(BigInt(BTC_TOKEN)) ?? [];
    const totalChange = changeNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(totalChange).toBe(depositAmount - swapAmount);
  }, 600_000);

  it("deposit USD + swap USD→BTC via Ekubo executor yields BTC output open note and USD change note", async () => {
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
    const swapAmount = 10n * ONE_TOKEN;

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
    console.log("[ekubo-swap-usd-btc] deposit submitted");

    const depositBlock = await provider.getBlockNumber();
    console.log(
      `[ekubo-swap-usd-btc] deposit confirmed at block ${depositBlock}`,
    );
    const MIN_PROVING_GAP = 10;
    const waitDeadline = Date.now() + 300_000;
    let currentBlock = depositBlock;
    while (currentBlock < depositBlock + MIN_PROVING_GAP) {
      if (Date.now() > waitDeadline) {
        throw new Error("Timed out waiting for blocks after deposit");
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      currentBlock = await provider.getBlockNumber();
      console.log(
        `[ekubo-swap-usd-btc] waiting for blocks: ${currentBlock}/${depositBlock + MIN_PROVING_GAP}`,
      );
    }
    const swapProvingBlockId = depositBlock;
    console.log(
      `[ekubo-swap-usd-btc] using swap proving block ${swapProvingBlockId}`,
    );

    const { callAndProof: swapCall } = await transfers
      .build({
        autoSetup: true,
        autoSelectNotes: "all",
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(USD_TOKEN)
      .withdraw({ recipient: EXECUTOR, amount: swapAmount })
      .surplusTo(alice.address, false)
      .with(BTC_TOKEN)
      .transfer({ recipient: alice.address, amount: Open, depositor: EXECUTOR })
      .done()
      .invoke((args) => {
        const openNote = args.openNotes[0];
        if (!openNote) {
          throw new Error("Expected one open note for swap invocation");
        }
        return {
          contractAddress: EXECUTOR,
          calldata: [
            USD_TOKEN,
            BTC_TOKEN,
            swapAmount,
            openNote.noteId,
            EKUBO_POOL_TOKEN0,
            EKUBO_POOL_TOKEN1,
            EKUBO_POOL_FEE,
            EKUBO_TICK_SPACING,
            EKUBO_EXTENSION,
            0n,
            0n,
            EKUBO_SKIP_AHEAD,
          ],
        };
      })
      .execute({ provingBlockId: swapProvingBlockId });
    console.log("[ekubo-swap-usd-btc] swap proved");

    await submitOutside(swapCall);
    console.log("[ekubo-swap-usd-btc] swap submitted");

    const notes = await waitForOutputNotes(transfers, BTC_TOKEN, 120_000);

    const outputNotes = notes.get(BigInt(BTC_TOKEN)) ?? [];
    const outputAmount = outputNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    expect(outputAmount).toBeGreaterThan(0n);
    expect(outputNotes.some((note) => note.open && note.amount > 0n)).toBe(
      true,
    );

    const changeNotes = notes.get(BigInt(USD_TOKEN)) ?? [];
    const totalChange = changeNotes.reduce(
      (sum, note) => sum + note.amount,
      0n,
    );
    // autoSelectNotes="all" sweeps the USD open note from test 1 into the
    // change, so the total is at least depositAmount - swapAmount.
    expect(totalChange).toBeGreaterThanOrEqual(depositAmount - swapAmount);
  }, 600_000);
});
