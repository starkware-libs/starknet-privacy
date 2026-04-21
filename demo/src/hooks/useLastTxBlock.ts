import { useRef, useEffect, useCallback } from "react";
import type { TransactionDisplay } from "./useHistory.ts";

/**
 * Tracks the block number of the most recent privacy pool transaction for
 * the active account. Used as a floor when computing `provingBlockId`.
 *
 * - Initialized from the latest history transaction's block number.
 * - Updated after each successful privacy pool tx.
 * - Reset on account change.
 */
export function useLastTxBlockNumber(
  activeAddress: string | undefined,
  historyTransactions: TransactionDisplay[],
) {
  const lastTxBlockNumberRef = useRef<number | undefined>(undefined);

  // Reset on account change.
  useEffect(() => {
    lastTxBlockNumberRef.current = undefined;
  }, [activeAddress]);

  // Initialize from history when first transactions arrive.
  useEffect(() => {
    if (lastTxBlockNumberRef.current === undefined && historyTransactions.length > 0) {
      const maxBlockNumber = Math.max(...historyTransactions.map((transaction) => transaction.blockNumber));
      lastTxBlockNumberRef.current = maxBlockNumber;
    }
  }, [historyTransactions]);

  const updateLastTxBlockNumber = useCallback((blockNumber: number) => {
    const current = lastTxBlockNumberRef.current;
    if (current === undefined || blockNumber > current) {
      lastTxBlockNumberRef.current = blockNumber;
    }
  }, []);

  return { lastTxBlockNumberRef, updateLastTxBlockNumber };
}
