/**
 * Smoke test: mint BTC, approve, swap BTC->USD via Ekubo Router.
 *
 * Usage: npm run setup-ekubo first, then:
 *   npx tsx --env-file=.env scripts/test-swap.ts
 */

import { Account, RpcProvider } from "starknet";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main() {
  const RPC = requireEnv("RPC_URL");
  const ACCOUNTS = JSON.parse(requireEnv("ACCOUNTS"));
  const admin = ACCOUNTS.find((a: { name: string }) => a.name === "admin");
  const ROUTER = requireEnv("EKUBO_ROUTER_ADDRESS");
  const TOKEN0 = requireEnv("EKUBO_POOL_TOKEN0");
  const TOKEN1 = requireEnv("EKUBO_POOL_TOKEN1");
  const FEE = requireEnv("EKUBO_POOL_FEE");
  const TICK_SPACING = requireEnv("EKUBO_TICK_SPACING");
  const EXTENSION = requireEnv("EKUBO_EXTENSION");

  const RB = {
    l2_gas: { max_amount: 2_000_000_000n, max_price_per_unit: 8_000_000_000n },
    l1_gas: { max_amount: 1n, max_price_per_unit: 1_500_000_000_000n },
    l1_data_gas: { max_amount: 5_000n, max_price_per_unit: 1_500n },
  };

  const provider = new RpcProvider({ nodeUrl: RPC });
  const account = new Account({
    provider,
    address: admin.address,
    signer: admin.privateKey,
    cairoVersion: "1",
  });

  const ONE_TOKEN = 10n ** 18n;
  console.log("Minting 100 BTC to admin...");
  const mintAmount = 100n * ONE_TOKEN;
  const mintLow = mintAmount & ((1n << 128n) - 1n);
  const mintHigh = mintAmount >> 128n;
  const mintTx = await account.execute(
    {
      contractAddress: TOKEN0,
      entrypoint: "permissionedMint",
      calldata: [admin.address, mintLow.toString(), mintHigh.toString()],
    },
    { tip: 0n, resourceBounds: RB },
  );
  await provider.waitForTransaction(mintTx.transaction_hash);

  const balBtcBefore = await provider.callContract({
    contractAddress: TOKEN0,
    entrypoint: "balance_of",
    calldata: [admin.address],
  });
  const balUsdBefore = await provider.callContract({
    contractAddress: TOKEN1,
    entrypoint: "balance_of",
    calldata: [admin.address],
  });
  const fmt = (raw: bigint) => `${raw / ONE_TOKEN}.${(raw % ONE_TOKEN).toString().padStart(18, "0").slice(0, 4)}`;
  console.log(
    `Before: BTC=${fmt(BigInt(balBtcBefore[0]))}, USD=${fmt(BigInt(balUsdBefore[0]))}`,
  );

  // sqrt_ratio_limit=0 lets the Router auto-pick min/max based on direction
  // Multicall: transfer BTC to router → swap → clear USD back to admin
  const swapAmount = 10n * ONE_TOKEN;
  const swapLow = swapAmount & ((1n << 128n) - 1n);
  const swapHigh = swapAmount >> 128n;
  console.log("Swapping 10 BTC -> USD (transfer → swap → clear)...");
  const swapTx = await account.execute(
    [
      {
        contractAddress: TOKEN0,
        entrypoint: "transfer",
        calldata: [ROUTER, swapLow.toString(), swapHigh.toString()],
      },
      {
        contractAddress: ROUTER,
        entrypoint: "swap",
        calldata: [
          // RouteNode
          TOKEN0, TOKEN1, FEE, TICK_SPACING, EXTENSION, // pool_key
          "0", "0",                                      // sqrt_ratio_limit=0 (auto)
          "0",                                           // skip_ahead
          // TokenAmount
          TOKEN0,                                        // token (selling BTC)
          swapLow.toString(), "0",                       // amount i129(mag, sign=false)
        ],
      },
      {
        contractAddress: ROUTER,
        entrypoint: "clear",
        calldata: [TOKEN1], // clear USD to caller
      },
    ],
    { tip: 0n, resourceBounds: RB },
  );
  const receipt = await provider.waitForTransaction(swapTx.transaction_hash);
  console.log(
    `Swap tx: ${swapTx.transaction_hash}, success: ${receipt.isSuccess()}`,
  );

  const balBtcAfter = await provider.callContract({
    contractAddress: TOKEN0,
    entrypoint: "balance_of",
    calldata: [admin.address],
  });
  const balUsdAfter = await provider.callContract({
    contractAddress: TOKEN1,
    entrypoint: "balance_of",
    calldata: [admin.address],
  });
  console.log(
    `After:  BTC=${fmt(BigInt(balBtcAfter[0]))}, USD=${fmt(BigInt(balUsdAfter[0]))}`,
  );
  const deltaBtc = BigInt(balBtcAfter[0]) - BigInt(balBtcBefore[0]);
  const deltaUsd = BigInt(balUsdAfter[0]) - BigInt(balUsdBefore[0]);
  console.log(
    `Delta:  BTC=${deltaBtc < 0n ? "-" : ""}${fmt(deltaBtc < 0n ? -deltaBtc : deltaBtc)}, USD=+${fmt(deltaUsd)}`,
  );
}

main().catch(console.error);
