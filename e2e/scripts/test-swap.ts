/**
 * Smoke test: mint BTC, swap BTC→USD via Ekubo Router, verify balances.
 *
 * Prerequisites: npm run deploy-ekubo (or populate .env with Ekubo addresses)
 * Usage: npm run test-swap (from e2e/, with .env populated)
 */

import { setupAdmin, requireEnv, u256Calldata } from "../src/utils.js";

const { adminAccount: account, provider } = setupAdmin();

const ROUTER = requireEnv("EKUBO_ROUTER_ADDRESS");
const TOKEN0 = requireEnv("EKUBO_POOL_TOKEN0");
const TOKEN1 = requireEnv("EKUBO_POOL_TOKEN1");
const FEE = requireEnv("EKUBO_POOL_FEE");
const TICK_SPACING = requireEnv("EKUBO_TICK_SPACING");
const EXTENSION = requireEnv("EKUBO_EXTENSION");

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

// Mint 100 BTC to admin
console.log("Minting 100 BTC to admin...");
const mintAmount = 100n * ONE_TOKEN;
const mintTx = await account.execute({
  contractAddress: TOKEN0,
  entrypoint: "mint",
  calldata: [account.address, ...u256Calldata(mintAmount)],
});
await provider.waitForTransaction(mintTx.transaction_hash);

const balBtcBefore = await getBalance(TOKEN0);
const balUsdBefore = await getBalance(TOKEN1);
console.log(`Before: BTC=${fmt(balBtcBefore)}, USD=${fmt(balUsdBefore)}`);

// Multicall: transfer BTC to router → swap → clear USD back to admin
// sqrt_ratio_limit=0 lets the Router auto-pick min/max based on direction
const swapAmount = 10n * ONE_TOKEN;
console.log("Swapping 10 BTC → USD (transfer → swap → clear)...");
const swapTx = await account.execute([
  {
    contractAddress: TOKEN0,
    entrypoint: "transfer",
    calldata: [ROUTER, ...u256Calldata(swapAmount)],
  },
  {
    contractAddress: ROUTER,
    entrypoint: "swap",
    calldata: [
      // RouteNode (pool_key)
      TOKEN0,
      TOKEN1,
      FEE,
      TICK_SPACING,
      EXTENSION,
      "0",
      "0", // sqrt_ratio_limit = 0 (auto)
      "0", // skip_ahead
      // TokenAmount
      TOKEN0, // token (selling BTC)
      swapAmount.toString(),
      "0", // i129(mag, sign=false)
    ],
  },
  {
    contractAddress: ROUTER,
    entrypoint: "clear",
    calldata: [TOKEN1], // clear USD to caller
  },
]);
const receipt = await provider.waitForTransaction(swapTx.transaction_hash);
console.log(
  `Swap tx: ${swapTx.transaction_hash}, success: ${receipt.isSuccess()}`,
);

const balBtcAfter = await getBalance(TOKEN0);
const balUsdAfter = await getBalance(TOKEN1);
console.log(`After:  BTC=${fmt(balBtcAfter)}, USD=${fmt(balUsdAfter)}`);
const deltaBtc = balBtcAfter - balBtcBefore;
const deltaUsd = balUsdAfter - balUsdBefore;
console.log(
  `Delta:  BTC=${deltaBtc < 0n ? "-" : ""}${fmt(deltaBtc < 0n ? -deltaBtc : deltaBtc)}, USD=+${fmt(deltaUsd)}`,
);
