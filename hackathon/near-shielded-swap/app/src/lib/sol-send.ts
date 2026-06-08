import {
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  OneClickService,
  QuoteRequest,
  TokenResponse,
  type QuoteResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import type { Token } from "../types";
import { findAssetByToken } from "./oneclick";

// 1 SOL = 10^9 lamports — kept local to avoid pulling
// `LAMPORTS_PER_SOL` from `@solana/web3.js` for one constant.
export function lamportsForSol(sol: number): bigint {
  // Float -> integer conversion via fixed-point string. Going through Number
  // arithmetic loses precision once the value exceeds 2^53; the string path
  // is safe for any UI-bound amount and matches `oneclick.toBaseUnits`.
  if (!Number.isFinite(sol) || sol <= 0) return 0n;
  const [intPart = "0", fracRaw = ""] = sol.toFixed(9).split(".");
  const frac = fracRaw.padEnd(9, "0").slice(0, 9);
  return BigInt(intPart + frac);
}

export interface BuildSolTransferArgs {
  from: string;
  to: string;
  lamports: bigint;
}

export function buildSolTransfer(args: BuildSolTransferArgs): Transaction {
  // Returns an unsigned `Transaction` with `feePayer` populated but no
  // `recentBlockhash` — the caller fetches the blockhash right before
  // signing so it doesn't expire while the user is interacting with the
  // wallet popup.
  const fromPubkey = new PublicKey(args.from);
  const toPubkey = new PublicKey(args.to);
  const transaction = new Transaction();
  transaction.feePayer = fromPubkey;
  transaction.add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey,
      lamports: args.lamports,
    }),
  );
  return transaction;
}

export interface RealQuoteArgs {
  from: Token;
  to: Token;
  amountIn: bigint;
  slippageBps: number;
  /** Per-swap mailbox address on the destination chain. */
  recipient: string;
  /** Per-swap refund address (on the origin chain). */
  refundTo: string;
  signal?: AbortSignal;
}

export interface RealQuoteResult {
  depositAddress: string;
  depositMemo?: string;
  amountIn: bigint;
  amountOut: bigint;
  deadline?: string;
  raw: QuoteResponse;
}

export async function requestRealQuote(
  args: RealQuoteArgs,
): Promise<RealQuoteResult> {
  // `previewQuote` in oneclick.ts uses `dry: true` which omits
  // `depositAddress`. The live deposit flow needs the real address, so we
  // duplicate the minimum payload here with `dry: false`. Asset resolution
  // is shared via `findAssetByToken` to keep the chain-mapping single-source.
  const [fromAsset, toAsset] = await Promise.all([
    findAssetByToken(args.from),
    findAssetByToken(args.to),
  ]);
  if (!fromAsset || !toAsset) {
    throw new Error(
      `Unsupported swap: ${args.from.symbol}@${args.from.chain} -> ${args.to.symbol}@${args.to.chain}`,
    );
  }
  if (args.signal?.aborted) throw new DOMException("aborted", "AbortError");

  const request: QuoteRequest = {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_INPUT,
    slippageTolerance: args.slippageBps,
    originAsset: fromAsset.assetId,
    destinationAsset: toAsset.assetId,
    amount: args.amountIn.toString(),
    refundTo: args.refundTo,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: args.recipient,
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

  const quote = response.quote;
  const depositAddress = quote.depositAddress;
  if (!depositAddress) {
    // A live quote on `ORIGIN_CHAIN` deposit type must include the deposit
    // address. Missing field means the upstream changed its contract; fail
    // loudly rather than silently no-op.
    throw new Error("1Click live quote missing depositAddress");
  }

  return {
    depositAddress,
    depositMemo: quote.depositMemo,
    amountIn: BigInt(quote.amountIn),
    amountOut: BigInt(quote.amountOut),
    deadline: quote.deadline,
    raw: response,
  };
}

// Re-export so callers don't need a separate import path for the SDK enum
// when narrowing to Solana flows.
export const SOLANA_BLOCKCHAIN = TokenResponse.blockchain.SOL;

// TODO: SPL token transfers (USDC on Solana) need a separate builder using
// `@solana/spl-token` — `getAssociatedTokenAddressSync` + `createTransferInstruction`,
// plus an `getOrCreateAssociatedTokenAccount`-style preflight for the
// deposit address. Out of scope for this turn.
