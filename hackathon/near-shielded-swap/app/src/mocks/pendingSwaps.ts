import type { PendingSwap } from "../types";

export const MOCK_PENDING: PendingSwap[] = [
  {
    id: "swap-0xa1f3",
    fromSymbol: "STRK",
    toSymbol: "ETH",
    fromAmount: 100,
    toAmount: 0.00934,
    startedAt: Math.floor(Date.now() / 1000) - 47,
    stages: {
      quote: "done",
      exit: "done",
      settling: "active",
      claim: "idle",
    },
  },
];
