import type { Quote, Token } from "../types";

// 5 bps "spread" + flat $0.18 network fee — close to what 1Click reports for small swaps.
const SPREAD_BPS = 5;
const NETWORK_FEE_USD = 0.18;

export function mockQuote(
  fromToken: Token,
  toToken: Token,
  fromAmount: number,
): Quote | null {
  if (!Number.isFinite(fromAmount) || fromAmount <= 0) return null;

  const inUsd = fromAmount * fromToken.usdPrice;
  const grossOutUsd = inUsd - NETWORK_FEE_USD;
  const spread = grossOutUsd * (SPREAD_BPS / 10_000);
  const netOutUsd = Math.max(0, grossOutUsd - spread);
  const outAmount = netOutUsd / toToken.usdPrice;

  return {
    inAmount: fromAmount,
    outAmount,
    inUsd,
    outUsd: netOutUsd,
    rate: outAmount / fromAmount,
    networkFeeUsd: NETWORK_FEE_USD,
    slippageBps: 50,
    routeLabel: "NEAR Intents · 1Click",
    deadlineSeconds: 150,
  };
}
