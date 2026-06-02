/**
 * Run the FULL private redemption flow against the live local devnet
 * (the one spawned by `bootstrap-demo.ts`). Reads the demo's .env.local for
 * addresses + accounts, connects as alice, does:
 *
 *   1. RequestRedeem (private)   — burns 50 fyUSDC shares, gets a redemption id
 *   2. Pad blocks
 *   3. admin → process_epoch(+10% pps)
 *   4. Pad blocks
 *   5. ClaimRedeem (private)     — produces a 55 USD private note
 *
 * After running, refresh the demo UI: alice should have a new USD note worth 55.
 *
 * Prerequisites:
 *   - bootstrap-demo.ts is running in another terminal
 *   - alice has 50 fyUSDC private notes (do a Forge Deposit in the UI first)
 *
 * Usage:
 *   cd e2e
 *   npx tsx scripts/test-redemption-flow.ts
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Account, RpcProvider, constants } from "starknet";
import {
  createPrivateTransfers,
  Open,
  type PrivateTransfersInterface,
} from "@starkware-libs/starknet-privacy-sdk";
import {
  CallMockProofProvider,
  IndexerDiscoveryProvider,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  buildForgeRequestRedeemInvoke,
  buildForgeClaimRedeemInvoke,
  forgeRedemptionCommitment,
  decodeRedemptionId,
  REDEMPTION_REQUESTED_EVENT_SELECTOR,
} from "@starkware-libs/starknet-privacy-sdk/anonymizers/forge";
import { u256Calldata } from "../src/utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Read demo's .env.local for addresses + accounts ──────────────────────────
const envPath = join(__dirname, "../../demo/.env.local");
const envText = readFileSync(envPath, "utf-8");
const env: Record<string, string> = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const RPC_URL = env.VITE_RPC_URL;
const INDEXER_URL = env.VITE_INDEXER_URL;
const POOL_ADDRESS = env.VITE_POOL_ADDRESS;
const FORGE_ANONYMIZER = env.VITE_FORGE_ANONYMIZER_ADDRESS;
const FORGE_GATEWAY = JSON.parse(env.VITE_FORGE).strategies[0].gateway;
const USD_TOKEN = JSON.parse(env.VITE_TOKENS)[0].address;
const accounts = JSON.parse(env.VITE_ACCOUNTS) as Array<{
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
}>;
const admin = accounts.find((a) => a.name === "admin")!;
const alice = accounts.find((a) => a.name === "alice")!;

console.log("=== Live devnet redemption flow ===");
console.log(`Pool:       ${POOL_ADDRESS}`);
console.log(`Anonymizer: ${FORGE_ANONYMIZER}`);
console.log(`Gateway:    ${FORGE_GATEWAY}`);
console.log(`USD:        ${USD_TOKEN}`);
console.log(`Alice:      ${alice.address}`);
console.log(`Admin:      ${admin.address}`);

// ── Build provider + accounts ────────────────────────────────────────────────
const provider = new RpcProvider({ nodeUrl: RPC_URL });
const aliceAccount = new Account({
  provider,
  address: alice.address,
  signer: alice.privateKey,
  cairoVersion: "1",
});
const adminAccount = new Account({
  provider,
  address: admin.address,
  signer: admin.privateKey,
  cairoVersion: "1",
});

const chainId = constants.StarknetChainId.SN_SEPOLIA;
const transfers: PrivateTransfersInterface = createPrivateTransfers({
  account: aliceAccount,
  viewingKeyProvider: { getViewingKey: async () => BigInt(alice.viewingKey) },
  provingProvider: new CallMockProofProvider(provider, chainId),
  discoveryProvider: new IndexerDiscoveryProvider(INDEXER_URL, POOL_ADDRESS),
  poolContractAddress: POOL_ADDRESS,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function padBlocks(n: number) {
  console.log(`  Padding ${n} empty blocks...`);
  for (let i = 0; i < n; i++) {
    await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "devnet_createBlock",
      }),
    });
  }
}

async function discoverNotes() {
  const { notes } = await transfers.discoverNotes();
  return notes;
}

async function logState(label: string) {
  const notes = await discoverNotes();
  const usd = (notes.get(BigInt(USD_TOKEN)) ?? []).reduce(
    (s, n) => s + n.amount,
    0n,
  );
  const shares = (notes.get(BigInt(FORGE_GATEWAY)) ?? []).reduce(
    (s, n) => s + n.amount,
    0n,
  );
  console.log(`\n[${label}] Alice private: USD=${usd}, fyUSDC=${shares}`);
}

// ── Main flow ─────────────────────────────────────────────────────────────────
await logState("INITIAL");

const ONE_TOKEN = 10n ** 18n;
const sharesToRedeem = 50n * ONE_TOKEN;

// 1. Generate secret + commitment locally (in a real wallet this would
//    be persisted alongside the viewing key)
const secret = "0xc0ffeedeadbeef";
const commitment = forgeRedemptionCommitment(secret);
console.log(`\nGenerated commitment: ${commitment}`);
console.log(`(secret kept in wallet: ${secret})`);

// 2. Submit RequestRedeem via the privacy pool
console.log("\n=== STEP 1: Private RequestRedeem ===");
await padBlocks(12);
const { callAndProof: requestCall } = await transfers
  .build({
    autoSetup: true,
    autoSelectNotes: "all",
    autoDiscover: { notes: "refresh", channels: "refresh" },
  })
  .with(FORGE_GATEWAY)
  .withdraw({ recipient: FORGE_ANONYMIZER, amount: sharesToRedeem })
  .surplusTo(alice.address, false)
  .done()
  .invoke(() =>
    buildForgeRequestRedeemInvoke({
      anonymizer: FORGE_ANONYMIZER,
      gateway: FORGE_GATEWAY,
      shares: sharesToRedeem,
      commitment,
    }),
  )
  .execute();

const requestTx = await aliceAccount.execute(requestCall.call, {
  tip: 0n,
  proofFacts: requestCall.proof.proofFacts,
  proof: requestCall.proof.data,
});
const requestReceipt = await provider.waitForTransaction(
  requestTx.transaction_hash,
);
console.log(`  Tx: ${requestTx.transaction_hash}`);
console.log(
  `  Status: ${requestReceipt.isSuccess?.() ? "SUCCEEDED" : "see receipt"}`,
);

// Pull the redemption id from the RedemptionRequested event
type ReceiptEvent = { from_address: string; keys: string[]; data: string[] };
const events: ReceiptEvent[] =
  "events" in requestReceipt
    ? (requestReceipt.events as ReceiptEvent[])
    : [];
const requestEvent = events.find(
  (ev) =>
    BigInt(ev.from_address) === BigInt(FORGE_ANONYMIZER) &&
    BigInt(ev.keys[0]) === BigInt(REDEMPTION_REQUESTED_EVENT_SELECTOR),
);
if (!requestEvent) throw new Error("RedemptionRequested event not found");
const redemptionId = decodeRedemptionId(requestEvent.data);
console.log(`  Redemption id: ${redemptionId}`);
console.log(`  Wallet stores locally: (id=${redemptionId}, secret=${secret})`);

await logState("AFTER request_redeem");

// 3. Admin: process_epoch(+10%)
console.log("\n=== STEP 2: Admin process_epoch (+10% pps) ===");
const newPps = (ONE_TOKEN * 110n) / 100n;
const epochTx = await adminAccount.execute({
  contractAddress: FORGE_GATEWAY,
  entrypoint: "process_epoch",
  calldata: u256Calldata(newPps),
});
await provider.waitForTransaction(epochTx.transaction_hash);
console.log(`  pps now = 1.1e18`);

// 4. Top up the gateway with the +10% yield (mock only — real strategy generates this)
console.log("\n=== STEP 3: Admin mints +10% yield to gateway ===");
const yieldAmount = (sharesToRedeem * 10n) / 100n;
const yieldTx = await adminAccount.execute({
  contractAddress: USD_TOKEN,
  entrypoint: "mint",
  calldata: [FORGE_GATEWAY, ...u256Calldata(yieldAmount)],
});
await provider.waitForTransaction(yieldTx.transaction_hash);

// 5. Private ClaimRedeem
console.log("\n=== STEP 4: Private ClaimRedeem (reveal secret) ===");
await padBlocks(12);
const { callAndProof: claimCall } = await transfers
  .build({
    autoSetup: true,
    autoSelectNotes: "all",
    autoDiscover: { notes: "refresh", channels: "refresh" },
  })
  .with(USD_TOKEN)
  .transfer({ recipient: alice.address, amount: Open })
  .done()
  .invoke((args) =>
    buildForgeClaimRedeemInvoke({
      anonymizer: FORGE_ANONYMIZER,
      gateway: FORGE_GATEWAY,
      underlying: USD_TOKEN,
      redemptionId,
      secret,
      noteId: args.openNotes[0].noteId,
    }),
  )
  .execute();

const claimTx = await aliceAccount.execute(claimCall.call, {
  tip: 0n,
  proofFacts: claimCall.proof.proofFacts,
  proof: claimCall.proof.data,
});
await provider.waitForTransaction(claimTx.transaction_hash);
console.log(`  Tx: ${claimTx.transaction_hash}`);

await logState("AFTER claim_redeem");

console.log("\n=== DONE ===");
console.log("Refresh the demo UI to see the new state.");
console.log(`Expected: USD private balance went up by ~55 (50 shares × 1.1 pps)`);
