/**
 * Smoke test: mint USD, deposit into Vesu vToken vault (ERC-4626),
 * verify vUSD shares received, redeem back, verify USD recovered.
 *
 * Prerequisites: npm run deploy-vesu (or populate .env with Vesu addresses)
 * Usage: npm run test-lending (from e2e/, with .env populated)
 */

import { setupAdmin, requireEnv, u256Calldata } from "../src/utils.js";

const { adminAccount: account, provider } = setupAdmin();

const USD_TOKEN = requireEnv("USD_TOKEN_ADDRESS");
const USD_VTOKEN = requireEnv("USD_VTOKEN_ADDRESS");

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

// Mint 100 USD to admin
console.log("Minting 100 USD to admin...");
const mintAmount = 100n * ONE_TOKEN;
const mintTx = await account.execute({
  contractAddress: USD_TOKEN,
  entrypoint: "mint",
  calldata: [account.address, ...u256Calldata(mintAmount)],
});
await provider.waitForTransaction(mintTx.transaction_hash);

// Approve vToken contract (the ERC-4626 vault) to pull USD
console.log("Approving vToken vault...");
const approveTx = await account.execute({
  contractAddress: USD_TOKEN,
  entrypoint: "approve",
  calldata: [USD_VTOKEN, ...u256Calldata(mintAmount)],
});
await provider.waitForTransaction(approveTx.transaction_hash);

const balUsdBefore = await getBalance(USD_TOKEN);
const balVTokenBefore = await getBalance(USD_VTOKEN);
console.log(`Before: USD=${fmt(balUsdBefore)}, vUSD=${fmt(balVTokenBefore)}`);

// Deposit 50 USD via vToken.deposit(assets, receiver) → mints vUSD shares
const depositAmount = 50n * ONE_TOKEN;
console.log(`\nDepositing ${fmt(depositAmount)} USD into vToken vault...`);
const depositTx = await account.execute({
  contractAddress: USD_VTOKEN,
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
const balVTokenAfterDeposit = await getBalance(USD_VTOKEN);
console.log(
  `After deposit:  USD=${fmt(balUsdAfterDeposit)}, vUSD=${fmt(balVTokenAfterDeposit)}`,
);
console.log(
  `  USD delta: -${fmt(balUsdBefore - balUsdAfterDeposit)}, vUSD delta: +${fmt(balVTokenAfterDeposit - balVTokenBefore)}`,
);

// Redeem all vUSD shares back to USD via vToken.redeem(shares, receiver, owner)
const sharesToRedeem = balVTokenAfterDeposit;
console.log(`\nRedeeming ${fmt(sharesToRedeem)} vUSD shares...`);
const redeemTx = await account.execute({
  contractAddress: USD_VTOKEN,
  entrypoint: "redeem",
  calldata: [...u256Calldata(sharesToRedeem), account.address, account.address],
});
const redeemReceipt = await provider.waitForTransaction(
  redeemTx.transaction_hash,
);
console.log(
  `Redeem tx: ${redeemTx.transaction_hash}, success: ${redeemReceipt.isSuccess()}`,
);

const balUsdFinal = await getBalance(USD_TOKEN);
const balVTokenFinal = await getBalance(USD_VTOKEN);
console.log(
  `After redeem:   USD=${fmt(balUsdFinal)}, vUSD=${fmt(balVTokenFinal)}`,
);
console.log(
  `  Net USD change: ${fmt(balUsdFinal - balUsdBefore)} (should be ~0)`,
);
