import {
  OneClickService,
  QuoteRequest,
  TokenResponse,
  type QuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import type { Token } from "../types";

const STARKNET = TokenResponse.blockchain.STARKNET;

// 1Click validates `recipient` / `refundTo` against the destination/origin
// chain even on `dry: true`. Starknet addresses are 64-hex felts; EVM ones are
// 40-hex; other chains have their own formats. We pick a benign placeholder
// per blockchain so the preview path passes validation. Real swaps replace
// these with the per-swap mailbox addresses.
const STARKNET_PLACEHOLDER =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const EVM_PLACEHOLDER = "0x0000000000000000000000000000000000000001";
const BTC_PLACEHOLDER = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"; // valid bech32
const SOL_PLACEHOLDER = "11111111111111111111111111111111";              // system program

function chainPlaceholder(blockchain: TokenResponse.blockchain): string {
  switch (blockchain) {
    case TokenResponse.blockchain.STARKNET:
      return STARKNET_PLACEHOLDER;
    case TokenResponse.blockchain.BTC:
      return BTC_PLACEHOLDER;
    case TokenResponse.blockchain.SOL:
      return SOL_PLACEHOLDER;
    default:
      // ETH-family and most others use 40-hex EVM-style addresses.
      return EVM_PLACEHOLDER;
  }
}

let tokenCache: Promise<TokenResponse[]> | null = null;

export async function fetchTokens(): Promise<TokenResponse[]> {
  if (!tokenCache) {
    tokenCache = OneClickService.getTokens().then((res) =>
      // Defensive copy — the SDK occasionally returns frozen objects.
      Array.from(res),
    );
  }
  return tokenCache;
}

export async function findAsset(
  symbol: string,
  blockchain: TokenResponse.blockchain = STARKNET,
): Promise<TokenResponse | null> {
  const all = await fetchTokens();
  const target = symbol.toLowerCase();
  return (
    all.find(
      (t) => t.blockchain === blockchain && t.symbol.toLowerCase() === target,
    ) ?? null
  );
}

const CHAIN_LABEL_TO_ENUM: Record<string, TokenResponse.blockchain> = {
  starknet: TokenResponse.blockchain.STARKNET,
  ethereum: TokenResponse.blockchain.ETH,
  arbitrum: TokenResponse.blockchain.ARB,
  base: TokenResponse.blockchain.BASE,
  optimism: TokenResponse.blockchain.OP,
  polygon: TokenResponse.blockchain.POL,
  bitcoin: TokenResponse.blockchain.BTC,
  solana: TokenResponse.blockchain.SOL,
  near: TokenResponse.blockchain.NEAR,
  bsc: TokenResponse.blockchain.BSC,
  avalanche: TokenResponse.blockchain.AVAX,
  tron: TokenResponse.blockchain.TRON,
  xrp: TokenResponse.blockchain.XRP,
  zec: TokenResponse.blockchain.ZEC,
};

export async function findAssetByToken(token: Token): Promise<TokenResponse | null> {
  const chain = CHAIN_LABEL_TO_ENUM[token.chain.toLowerCase()];
  if (!chain) return null;
  return findAsset(token.symbol, chain);
}

export interface QuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  amountInUsd: number;
  amountOutUsd: number;
  rate: number;
  slippageBps: number;
  deadline?: string;
  routeLabel: string;
  raw: QuoteResponse;
}

export async function previewQuote(args: {
  from: Token;
  to: Token;
  amountIn: bigint;
  slippageBps: number;
  /** Override the destination recipient (default: chain-shaped placeholder). */
  recipient?: string;
  /** Override the refund target (default: chain-shaped placeholder). For the
   *  anonymizer flow, this is the per-swap refund mailbox on Starknet. */
  refundTo?: string;
  signal?: AbortSignal;
}): Promise<QuoteResult | null> {
  // Map our token's `chain` field to the 1Click blockchain enum. Done by
  // matching against the asset catalog: both `from` and `to` must resolve to
  // a known asset on a known chain, or the swap is unsupported.
  const [fromAsset, toAsset] = await Promise.all([
    findAssetByToken(args.from),
    findAssetByToken(args.to),
  ]);
  if (!fromAsset || !toAsset) return null;
  if (args.signal?.aborted) throw new DOMException("aborted", "AbortError");

  const request: QuoteRequest = {
    dry: true,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: args.slippageBps,
    originAsset: fromAsset.assetId,
    destinationAsset: toAsset.assetId,
    amount: args.amountIn.toString(),
    refundTo: args.refundTo ?? chainPlaceholder(fromAsset.blockchain),
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: args.recipient ?? chainPlaceholder(toAsset.blockchain),
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
  };

  const promise = OneClickService.getQuote(request);
  if (args.signal) {
    args.signal.addEventListener("abort", () => promise.cancel(), {
      once: true,
    });
  }
  const response = await promise;
  if (args.signal?.aborted) throw new DOMException("aborted", "AbortError");

  const q = response.quote;
  const amountIn = BigInt(q.amountIn);
  const amountOut = BigInt(q.amountOut);
  const inFmt = parseFloat(q.amountInFormatted || "0");
  const outFmt = parseFloat(q.amountOutFormatted || "0");

  return {
    amountIn,
    amountOut,
    amountInUsd: parseFloat(q.amountInUsd || "0"),
    amountOutUsd: parseFloat(q.amountOutUsd || "0"),
    rate: inFmt > 0 ? outFmt / inFmt : 0,
    slippageBps: args.slippageBps,
    deadline: q.deadline,
    routeLabel: "NEAR Intents · 1Click",
    raw: response,
  };
}

export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const [intPart = "0", fracRaw = ""] = amount.toFixed(decimals).split(".");
  const frac = fracRaw.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(intPart + frac);
}

export function fromBaseUnits(amount: bigint, decimals: number): number {
  if (amount === 0n) return 0;
  const s = amount.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, -decimals);
  const fracPart = s.slice(-decimals).replace(/0+$/, "");
  return parseFloat(fracPart ? `${intPart}.${fracPart}` : intPart);
}
