export interface Token {
  /** Stable identifier across (symbol, chain). e.g. "eth-ethereum". */
  id: string;
  symbol: string;
  name: string;
  chain: string;
  /** Lowercase chain tag matching 1Click's blockchain enum. */
  chainTag: string;
  decimals: number;
  iconTint: string;
  usdPrice: number;
  /** Only meaningful for source tokens (shielded balance in pool). */
  shieldedBalance?: number;
}

export interface Quote {
  inAmount: number;
  outAmount: number;
  inUsd: number;
  outUsd: number;
  rate: number;
  networkFeeUsd: number;
  slippageBps: number;
  routeLabel: string;
  deadlineSeconds: number;
}

export type SwapStage = "quote" | "exit" | "settling" | "claim";
export type StageStatus = "idle" | "active" | "done" | "failed";

export interface PendingSwap {
  id: string;
  fromSymbol: string;
  toSymbol: string;
  fromAmount: number;
  toAmount: number;
  startedAt: number;
  stages: Record<SwapStage, StageStatus>;
}
