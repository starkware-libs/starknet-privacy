/**
 * Smoke test: mint USD, deposit into the Forge mock gateway (ERC-4626-shaped),
 * verify shares received, simulate yield via process_epoch, verify shares
 * appreciate against the new pps.
 *
 * Prerequisites: npm run deploy-forge (or populate .env with Forge addresses)
 * Usage: npm run test-yield (from e2e/, with .env populated)
 */

import { setupAdmin, requireEnv, u256Calldata } from "../src/utils.js";
import { processForgeEpoch } from "../src/forge-setup.js";

const { adminAccount: account, provider } = setupAdmin();

const USD_TOKEN = requireEnv("USD_TOKEN_ADDRESS");
const FORGE_GATEWAY = requireEnv("FORGE_GATEWAY_ADDRESS");

const ONE_TOKEN = 10n ** 18n;
const fmt = (raw: bigint) =>
  `${raw / ONE_TOKEN}.${(raw % ONE_TOKEN).toString().padStart(18, "0").slice(0, 4)}`;

async function getBalance(token: string): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: token,
    entrypoint: "balance_of",
    calldata: [account.address],
  });
  return BigInt(result[0]);
}

async function readU256View(
  contract: string,
  entrypoint: string,
  calldata: bigint[] = [],
): Promise<bigint> {
  const result = await provider.callContract({
    contractAddress: contract,
    entrypoint,
    calldata,
  });
  return BigInt(result[0]);
}

// Mint 100 USD to admin
console.log("Minting 100 USD to admin...");
const mintAmount = 100n * ONE_TOKEN;
const mintTx = await account.execute({
  contractAddress: USD_TOKEN,
  entrypoint: "mint",
  calldata: [account.address, ...u256Calldata(mintAmount)],
});
await provider.waitForTransaction(mintTx.transaction_hash);

// Approve the gateway (acts as both vault and share token) to pull USD
console.log("Approving Forge gateway...");
const approveTx = await account.execute({
  contractAddress: USD_TOKEN,
  entrypoint: "approve",
  calldata: [FORGE_GATEWAY, ...u256Calldata(mintAmount)],
});
await provider.waitForTransaction(approveTx.transaction_hash);

const balUsdBefore = await getBalance(USD_TOKEN);
const balSharesBefore = await getBalance(FORGE_GATEWAY);
console.log(`Before: USD=${fmt(balUsdBefore)}, shares=${fmt(balSharesBefore)}`);

// Deposit 50 USD via gateway.deposit(assets, receiver) → mints shares
const depositAmount = 50n * ONE_TOKEN;
console.log(`\nDepositing ${fmt(depositAmount)} USD into Forge gateway...`);
const depositTx = await account.execute({
  contractAddress: FORGE_GATEWAY,
  entrypoint: "deposit",
  calldata: [...u256Calldata(depositAmount), account.address],
});
const depositReceipt = await provider.waitForTransaction(
  depositTx.transaction_hash,
);
console.log(
  `Deposit tx: ${depositTx.transaction_hash}, success: ${depositReceipt.isSuccess()}`,
);

const balUsdAfterDeposit = await getBalance(USD_TOKEN);
const balSharesAfterDeposit = await getBalance(FORGE_GATEWAY);
console.log(
  `After deposit:  USD=${fmt(balUsdAfterDeposit)}, shares=${fmt(balSharesAfterDeposit)}`,
);
console.log(
  `  USD delta: -${fmt(balUsdBefore - balUsdAfterDeposit)}, shares delta: +${fmt(balSharesAfterDeposit - balSharesBefore)}`,
);

// Simulate +10% yield via the mock-only process_epoch shortcut.
const newPps = (ONE_TOKEN * 110n) / 100n; // 1.1e18
console.log(`\nSimulating +10% yield: process_epoch(pps=${fmt(newPps)})...`);
await processForgeEpoch(account, provider, FORGE_GATEWAY, newPps);

const ppsAfter = await readU256View(FORGE_GATEWAY, "pps");
const equivalentAssets = await readU256View(
  FORGE_GATEWAY,
  "convert_to_assets",
  u256Calldata(balSharesAfterDeposit),
);
console.log(
  `pps now ${fmt(ppsAfter)}; ${fmt(balSharesAfterDeposit)} shares are worth ${fmt(equivalentAssets)} USD of underlying`,
);
