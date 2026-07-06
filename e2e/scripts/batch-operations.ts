/**
 * Batch operations script: creates many notes via chunked deposits or transfers.
 *
 * Modes:
 *   deposit   — Alice deposits tokens into the pool (self-notes)
 *   transfer  — Alice transfers private notes to a recipient (e.g. Charlie)
 *
 * Each chunk processes CHUNK_SIZE operations in a single transaction. Between
 * chunks the script waits for enough blocks so the proving service sees the
 * previous chunk's state.
 *
 * Reads env vars:
 *   VITE_RPC_URL, VITE_TOKEN_ADDRESS, VITE_CHAIN_ID, VITE_POOL_ADDRESS,
 *   VITE_PROVING_SERVICE_URL, VITE_INDEXER_URL,
 *   ACCOUNTS
 *
 * CLI args:
 *   --mode <deposit|transfer>  Operation mode (default: deposit)
 *   --count <n>                Total number of operations (default: 500)
 *   --chunk <n>                Operations per transaction (default: 25, max ~25 before OOG)
 *   --amount <n>               Token amount per operation (default: 1)
 *   --recipient <name>         Recipient account name for transfer mode (default: Charlie)
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/batch-operations.ts --mode deposit --count 500
 *   npx tsx --env-file=.env scripts/batch-operations.ts --mode deposit --count 100 --amount 10
 *   npx tsx --env-file=.env scripts/batch-operations.ts --mode transfer --count 25 --recipient Charlie --amount 10
 */

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
  type CallAndProof,
  type TokenOperationsBuilder,
} from "@starkware-libs/starknet-privacy-sdk";
interface AccountEntry {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
  admin?: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseIntArg(
  args: string[],
  flag: string,
  defaultValue: number,
): number {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return defaultValue;
  const value = parseInt(args[index + 1], 10);
  if (isNaN(value) || value <= 0) {
    console.error(`Invalid value for ${flag}: ${args[index + 1]}`);
    process.exit(1);
  }
  return value;
}

function parseStringArg(
  args: string[],
  flag: string,
  defaultValue: string,
): string {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return defaultValue;
  return args[index + 1];
}

function findAccount(accounts: AccountEntry[], name: string): AccountEntry {
  const entry = accounts.find(
    (account) => account.name.toLowerCase() === name.toLowerCase(),
  );
  if (!entry) throw new Error(`Account "${name}" not found in ACCOUNTS`);
  return entry;
}

function findAdmin(accounts: AccountEntry[]): AccountEntry {
  const entry = accounts.find((a) => a.admin);
  if (!entry)
    throw new Error("No admin account (admin: true) found in ACCOUNTS");
  return entry;
}

const cliArgs = process.argv.slice(2);
const mode = parseStringArg(cliArgs, "--mode", "deposit") as
  | "deposit"
  | "transfer";
if (mode !== "deposit" && mode !== "transfer") {
  console.error(`Invalid --mode: ${mode}. Must be "deposit" or "transfer".`);
  process.exit(1);
}
const totalOperations = parseIntArg(cliArgs, "--count", 500);
const chunkSize = parseIntArg(cliArgs, "--chunk", 25);
const operationAmount = BigInt(parseIntArg(cliArgs, "--amount", 1));
const recipientName = parseStringArg(cliArgs, "--recipient", "Charlie");
const numIterations = Math.ceil(totalOperations / chunkSize);
const totalAmount = BigInt(totalOperations) * operationAmount;

const RPC = requireEnv("VITE_RPC_URL");
const TOKEN = requireEnv("VITE_TOKEN_ADDRESS");
const CHAIN_ID = requireEnv("VITE_CHAIN_ID") as constants.StarknetChainId;
const POOL_ADDRESS = requireEnv("VITE_POOL_ADDRESS");
const PROVING_SERVICE_URL = requireEnv("VITE_PROVING_SERVICE_URL");
const INDEXER_URL = requireEnv("VITE_INDEXER_URL");
const accounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));
const admin = findAdmin(accounts);
const alice = findAccount(accounts, "alice");

const L2_GAS_PRICE = 16_000_000_000n;
const L1_GAS_PRICE = 1_000_000_000_000n;
const L1_DATA_GAS_PRICE = 2_000n;
const ERC20_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 640n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const POOL_RESOURCE_BOUNDS = {
  l2_gas: { max_amount: 2_000_000_000n, max_price_per_unit: L2_GAS_PRICE },
  l1_gas: { max_amount: 1n, max_price_per_unit: L1_GAS_PRICE },
  l1_data_gas: { max_amount: 10_000n, max_price_per_unit: L1_DATA_GAS_PRICE },
};
const PROVING_BLOCK_OFFSET = 10;

async function waitForProvingBlock(
  provider: RpcProvider,
  minProvingBlock: number,
): Promise<number> {
  let latestBlockNumber = await provider.getBlockNumber();
  while (latestBlockNumber - PROVING_BLOCK_OFFSET < minProvingBlock) {
    const blocksToWait =
      minProvingBlock - (latestBlockNumber - PROVING_BLOCK_OFFSET);
    process.stdout.write(`  waiting for ${blocksToWait} more blocks...\r`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    latestBlockNumber = await provider.getBlockNumber();
  }
  return latestBlockNumber - PROVING_BLOCK_OFFSET;
}

async function submitOutsideExecution(
  provider: RpcProvider,
  aliceAccount: Account,
  adminAccount: Account,
  callAndProof: CallAndProof,
): Promise<{ transactionHash: string; blockNumber: number | undefined }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const callOptions: OutsideExecutionOptions = {
    caller: admin.address,
    execute_after: nowSeconds - 3600,
    execute_before: nowSeconds + 3600,
  };
  const outsideTransaction = await aliceAccount.getOutsideTransaction(
    callOptions,
    callAndProof.call,
    OutsideExecutionVersion.V2,
  );
  const executeTx = await adminAccount.executeFromOutside(outsideTransaction, {
    tip: 0n,
    resourceBounds: POOL_RESOURCE_BOUNDS,
    proofFacts: callAndProof.proof.proofFacts,
    proof: callAndProof.proof.data,
  });
  const receipt = await provider.waitForTransaction(executeTx.transaction_hash);
  if (!receipt.isSuccess()) {
    console.error("  REVERTED:", JSON.stringify(receipt, null, 2));
    process.exit(1);
  }
  return {
    transactionHash: executeTx.transaction_hash,
    blockNumber: receipt.block_number,
  };
}

async function discoverAndVerify(
  discovery: IndexerDiscoveryProvider,
  account: AccountEntry,
  expectedMinimum: number,
): Promise<number> {
  console.log("Polling discovery service...");
  const pollDeadline = Date.now() + 120_000;
  let noteCount = 0;
  while (Date.now() < pollDeadline) {
    const result = await discovery.discoverNotes(
      BigInt(account.address),
      BigInt(account.viewingKey),
      { tokens: [BigInt(TOKEN)] },
    );
    const tokenNotes = result.notes.get(BigInt(TOKEN));
    noteCount = tokenNotes?.length ?? 0;
    console.log(`  discovered ${noteCount} notes for ${account.name}`);
    if (noteCount >= expectedMinimum) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return noteCount;
}

async function runDeposit() {
  console.log(
    `Batch deposit: ${totalOperations} deposits in ${numIterations} chunks of ${chunkSize}`,
  );
  console.log(`Pool: ${POOL_ADDRESS}`);
  console.log(`Token: ${TOKEN}`);

  const provider = new RpcProvider({ nodeUrl: RPC });
  const adminAccount = new Account({
    provider,
    address: admin.address,
    signer: admin.privateKey,
    cairoVersion: "1",
  });
  const aliceAccount = new Account({
    provider,
    address: alice.address,
    signer: alice.privateKey,
    cairoVersion: "1",
  });
  const discovery = new IndexerDiscoveryProvider(INDEXER_URL, POOL_ADDRESS);

  // Mint and approve
  console.log(`\nMinting ${totalAmount} tokens to alice...`);
  const mintTx = await adminAccount.execute(
    {
      contractAddress: TOKEN,
      entrypoint: "permissionedMint",
      calldata: [alice.address, totalAmount.toString(), "0"],
    },
    { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
  );
  const mintReceipt = await provider.waitForTransaction(
    mintTx.transaction_hash,
  );
  if (!mintReceipt.isSuccess()) {
    console.error("Mint failed");
    process.exit(1);
  }
  console.log("Mint tx:", mintTx.transaction_hash);

  console.log(`Approving pool to spend ${totalAmount} tokens...`);
  const approveTx = await aliceAccount.execute(
    {
      contractAddress: TOKEN,
      entrypoint: "approve",
      calldata: [POOL_ADDRESS, totalAmount.toString(), "0"],
    },
    { tip: 0n, resourceBounds: ERC20_RESOURCE_BOUNDS },
  );
  const approveReceipt = await provider.waitForTransaction(
    approveTx.transaction_hash,
  );
  if (!approveReceipt.isSuccess()) {
    console.error("Approve failed");
    process.exit(1);
  }
  console.log("Approve tx:", approveTx.transaction_hash);

  const transfers = createPrivateTransfers({
    account: aliceAccount,
    viewingKeyProvider: { getViewingKey: async () => BigInt(alice.viewingKey) },
    provingProvider: new ProvingServiceProofProvider(
      PROVING_SERVICE_URL,
      CHAIN_ID,
    ),
    discoveryProvider: discovery,
    poolContractAddress: POOL_ADDRESS,
  });

  const depositInputs = Array.from({ length: chunkSize }, () => ({
    amount: operationAmount,
    recipient: alice.address,
  }));

  let minProvingBlock = 0;
  const startTime = Date.now();

  for (let iteration = 0; iteration < numIterations; iteration++) {
    const depositsThisChunk = Math.min(
      chunkSize,
      totalOperations - iteration * chunkSize,
    );
    const inputs = depositInputs.slice(0, depositsThisChunk);

    console.log(
      `\n[${iteration + 1}/${numIterations}] Depositing ${depositsThisChunk} notes...`,
    );
    const provingBlockId = await waitForProvingBlock(provider, minProvingBlock);

    const { callAndProof } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
      })
      .with(TOKEN, (tokenBuilder: TokenOperationsBuilder) =>
        tokenBuilder.deposit(...inputs),
      )
      .execute({ provingBlockId });

    const result = await submitOutsideExecution(
      provider,
      aliceAccount,
      adminAccount,
      callAndProof,
    );
    console.log(`  confirmed: ${result.transactionHash}`);
    if (result.blockNumber != null) minProvingBlock = result.blockNumber + 1;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nAll ${totalOperations} deposits submitted in ${elapsed}s`);

  const noteCount = await discoverAndVerify(discovery, alice, totalOperations);
  if (noteCount >= totalOperations) {
    console.log(
      `\nSuccess: ${noteCount} notes discovered (>= ${totalOperations} expected)`,
    );
  } else {
    console.error(
      `\nFailed: only ${noteCount} notes discovered (expected >= ${totalOperations})`,
    );
    process.exit(1);
  }
}

async function runTransfer() {
  const recipient = findAccount(accounts, recipientName);
  console.log(
    `Batch transfer: ${totalOperations} transfers (alice -> ${recipient.name}) in ${numIterations} chunks of ${chunkSize}`,
  );
  console.log(`Pool: ${POOL_ADDRESS}`);
  console.log(`Token: ${TOKEN}`);

  const provider = new RpcProvider({ nodeUrl: RPC });
  const adminAccount = new Account({
    provider,
    address: admin.address,
    signer: admin.privateKey,
    cairoVersion: "1",
  });
  const aliceAccount = new Account({
    provider,
    address: alice.address,
    signer: alice.privateKey,
    cairoVersion: "1",
  });
  const discovery = new IndexerDiscoveryProvider(INDEXER_URL, POOL_ADDRESS);

  // Check Alice's current balance in the pool
  console.log("\nDiscovering alice's current notes...");
  const aliceNotes = await discovery.discoverNotes(
    BigInt(alice.address),
    BigInt(alice.viewingKey),
    { tokens: [BigInt(TOKEN)] },
  );
  const aliceTokenNotes = aliceNotes.notes.get(BigInt(TOKEN)) ?? [];
  const aliceBalance = aliceTokenNotes.reduce(
    (sum, note) => sum + note.amount,
    0n,
  );
  console.log(
    `Alice has ${aliceTokenNotes.length} notes, total balance: ${aliceBalance}`,
  );
  if (aliceBalance < totalAmount) {
    console.error(
      `Insufficient balance: need ${totalAmount}, have ${aliceBalance}`,
    );
    console.error("Run deposit mode first to fund alice's pool balance.");
    process.exit(1);
  }

  // Discover recipient's notes before transfer to get baseline count
  console.log(`\nDiscovering ${recipient.name}'s current notes...`);
  const recipientNotesBefore = await discovery.discoverNotes(
    BigInt(recipient.address),
    BigInt(recipient.viewingKey),
    { tokens: [BigInt(TOKEN)] },
  );
  const recipientCountBefore =
    recipientNotesBefore.notes.get(BigInt(TOKEN))?.length ?? 0;
  console.log(
    `${recipient.name} has ${recipientCountBefore} notes before transfer`,
  );

  const transfers = createPrivateTransfers({
    account: aliceAccount,
    viewingKeyProvider: { getViewingKey: async () => BigInt(alice.viewingKey) },
    provingProvider: new ProvingServiceProofProvider(
      PROVING_SERVICE_URL,
      CHAIN_ID,
    ),
    discoveryProvider: discovery,
    poolContractAddress: POOL_ADDRESS,
  });

  const transferOutputs = Array.from({ length: chunkSize }, () => ({
    amount: operationAmount,
    recipient: recipient.address,
  }));

  let minProvingBlock = 0;
  const startTime = Date.now();

  for (let iteration = 0; iteration < numIterations; iteration++) {
    const transfersThisChunk = Math.min(
      chunkSize,
      totalOperations - iteration * chunkSize,
    );
    const outputs = transferOutputs.slice(0, transfersThisChunk);

    console.log(
      `\n[${iteration + 1}/${numIterations}] Transferring ${transfersThisChunk} notes to ${recipient.name}...`,
    );
    const provingBlockId = await waitForProvingBlock(provider, minProvingBlock);

    const { callAndProof } = await transfers
      .build({
        autoRegister: true,
        autoSetup: true,
        autoDiscover: { notes: "refresh", channels: "refresh" },
        autoSelectNotes: "naive",
      })
      .with(TOKEN, (tokenBuilder: TokenOperationsBuilder) =>
        tokenBuilder.transfer(...outputs),
      )
      .surplusTo(alice.address)
      .execute({ provingBlockId });

    const result = await submitOutsideExecution(
      provider,
      aliceAccount,
      adminAccount,
      callAndProof,
    );
    console.log(`  confirmed: ${result.transactionHash}`);
    if (result.blockNumber != null) minProvingBlock = result.blockNumber + 1;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nAll ${totalOperations} transfers submitted in ${elapsed}s`);

  // Verify recipient received the notes
  const expectedMinimum = recipientCountBefore + totalOperations;
  const noteCount = await discoverAndVerify(
    discovery,
    recipient,
    expectedMinimum,
  );

  const newNotes = noteCount - recipientCountBefore;
  if (newNotes >= totalOperations) {
    console.log(
      `\nSuccess: ${recipient.name} has ${newNotes} new notes (${noteCount} total, was ${recipientCountBefore})`,
    );
  } else {
    console.error(
      `\nFailed: ${recipient.name} has only ${newNotes} new notes (expected >= ${totalOperations})`,
    );
    process.exit(1);
  }
}

async function main() {
  if (mode === "deposit") {
    await runDeposit();
  } else {
    await runTransfer();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
