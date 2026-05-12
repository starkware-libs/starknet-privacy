import { useEffect, useState } from "react";
import {
  startStatusPoller,
  type ExecutionStatus,
} from "../lib/oneclick-status";

const DEFAULT_POLL_INTERVAL_MS = 4_000;

export type OneClickStatusKind =
  | { kind: "idle" }
  | { kind: "polling" }
  | { kind: "settled"; status: ExecutionStatus }
  | { kind: "error"; message: string };

export interface UseOneClickStatusOptions {
  /** Deposit address from the quote response. Polling pauses while `null`. */
  depositAddress: string | null;
  /** Override the 4s default; useful for tests. */
  intervalMs?: number;
}

export interface UseOneClickStatusResult {
  /** Coarse hook state. */
  status: OneClickStatusKind;
  /** Latest known execution status from 1Click (sticky across re-polls). */
  executionStatus: ExecutionStatus | null;
}

/** Polls `OneClickService.getExecutionStatus(depositAddress)` on an interval
 *  until 1Click reports a terminal state (SUCCESS / REFUNDED / FAILED). */
export function useOneClickStatus(
  options: UseOneClickStatusOptions,
): UseOneClickStatusResult {
  const { depositAddress, intervalMs = DEFAULT_POLL_INTERVAL_MS } = options;
  const [status, setStatus] = useState<OneClickStatusKind>({ kind: "idle" });
  const [executionStatus, setExecutionStatus] =
    useState<ExecutionStatus | null>(null);

  useEffect(() => {
    if (!depositAddress) {
      setStatus({ kind: "idle" });
      setExecutionStatus(null);
      return;
    }

    setStatus({ kind: "polling" });
    const handle = startStatusPoller(depositAddress, intervalMs, {
      onStatus: (next) => setExecutionStatus(next),
      onError: (message) => setStatus({ kind: "error", message }),
      onSettled: (terminal) =>
        setStatus({ kind: "settled", status: terminal }),
    });

    return () => handle.cancel();
  }, [depositAddress, intervalMs]);

  return { status, executionStatus };
}
