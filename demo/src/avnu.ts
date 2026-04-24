/**
 * Minimal AVNU swap client — only the two REST endpoints the demo needs.
 *
 * This replaces a previous dependency on `@avnu/avnu-sdk`, which had to be
 * vendored because the upstream branch (`feat/private-swap`) carrying the
 * `private?: boolean` flag on `QuoteToCallsParams` doesn't publish `dist/`
 * or a `prepare` hook. The demo only uses `getQuotes` and `quoteToCalls`,
 * so we inline thin wrappers over the public AVNU API here and drop the
 * SDK entirely.
 *
 * API reference: https://starknet.api.avnu.fi
 * Private-swap flag triggers AVNU's private executor path required by the
 * privacy pool's `avnuSwap` flow in `useTransactions.ts`.
 */

import type { Call } from "starknet";

const AVNU_BASE_URL = "https://starknet.api.avnu.fi";
const AVNU_SWAP_VERSION = "v3";

export type AvnuQuoteRequest = {
  sellTokenAddress: string;
  buyTokenAddress: string;
  sellAmount: bigint;
  takerAddress?: string;
  size?: number;
};

export type AvnuQuote = {
  quoteId: string;
  buyAmount: bigint;
  // Other fields (routes, sellAmount, prices, etc.) are passed through
  // unchanged; the demo only reads quoteId and buyAmount today.
  [key: string]: unknown;
};

export type AvnuQuoteToCallsParams = {
  quoteId: string;
  slippage: number;
  takerAddress?: string;
  /** Route through AVNU's private executor — required for the privacy pool. */
  private?: boolean;
};

export type AvnuCalls = {
  calls: Call[];
  executorAddress?: string;
  chainId?: string;
};

const toHex = (value: bigint): string => `0x${value.toString(16)}`;

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${text ? `: ${text}` : ""}`;
}

export async function getQuotes(request: AvnuQuoteRequest): Promise<AvnuQuote[]> {
  const params = new URLSearchParams({
    sellTokenAddress: request.sellTokenAddress,
    buyTokenAddress: request.buyTokenAddress,
    sellAmount: toHex(request.sellAmount),
  });
  if (request.takerAddress) params.set("takerAddress", request.takerAddress);
  if (request.size != null) params.set("size", String(request.size));

  const url = `${AVNU_BASE_URL}/swap/${AVNU_SWAP_VERSION}/quotes?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`AVNU getQuotes: ${await readError(response)}`);
  const raw = (await response.json()) as Array<Record<string, unknown>>;
  return raw.map((quote) => ({
    ...quote,
    quoteId: String(quote.quoteId),
    buyAmount: BigInt(quote.buyAmount as string | number | bigint),
  }));
}

export async function quoteToCalls(params: AvnuQuoteToCallsParams): Promise<AvnuCalls> {
  const url = `${AVNU_BASE_URL}/swap/${AVNU_SWAP_VERSION}/build`;
  const body: Record<string, unknown> = {
    quoteId: params.quoteId,
    slippage: params.slippage,
  };
  if (params.takerAddress) body.takerAddress = params.takerAddress;
  if (params.private) body.private = true;

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`AVNU quoteToCalls: ${await readError(response)}`);
  return (await response.json()) as AvnuCalls;
}
