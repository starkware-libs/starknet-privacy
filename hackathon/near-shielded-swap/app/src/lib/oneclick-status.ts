import {
  OneClickService,
  GetExecutionStatusResponse,
} from "@defuse-protocol/one-click-sdk-typescript";

/** 1Click's terminal "settled" status — STRK has been delivered to the
 *  destination recipient (the per-swap output mailbox in our case). */
export const SUCCESS = GetExecutionStatusResponse.status.SUCCESS;

/** Terminal "no settlement" statuses — the source funds were returned to the
 *  refund address on the origin chain. */
export const TERMINAL_REFUND: readonly GetExecutionStatusResponse.status[] = [
  GetExecutionStatusResponse.status.REFUNDED,
  GetExecutionStatusResponse.status.FAILED,
];

/** In-flight statuses where the deposit has been seen and is being routed. */
export const SETTLING: readonly GetExecutionStatusResponse.status[] = [
  GetExecutionStatusResponse.status.KNOWN_DEPOSIT_TX,
  GetExecutionStatusResponse.status.PENDING_DEPOSIT,
  GetExecutionStatusResponse.status.INCOMPLETE_DEPOSIT,
  GetExecutionStatusResponse.status.PROCESSING,
];

export type ExecutionStatus = GetExecutionStatusResponse.status;

export function isTerminal(status: ExecutionStatus): boolean {
  return status === SUCCESS || TERMINAL_REFUND.includes(status);
}

export function isRefund(status: ExecutionStatus): boolean {
  return TERMINAL_REFUND.includes(status);
}

export function isSettling(status: ExecutionStatus): boolean {
  return SETTLING.includes(status);
}

export interface FetchStatusResult {
  status: ExecutionStatus;
  raw: GetExecutionStatusResponse;
}

/** Single-shot fetch of the swap execution status. Wraps the 1Click SDK so
 *  callers don't depend on the import path or the cancellable-promise shape. */
export async function fetchExecutionStatus(
  depositAddress: string,
): Promise<FetchStatusResult> {
  const response = await OneClickService.getExecutionStatus(depositAddress);
  return { status: response.status, raw: response };
}

export interface PollerCallbacks {
  onStatus: (status: ExecutionStatus) => void;
  onError: (message: string) => void;
  onSettled: (status: ExecutionStatus) => void;
}

export interface PollerHandle {
  /** Stop polling. Idempotent. */
  cancel: () => void;
}

/** Drives an interval-based poll loop until either `cancel()` is called or
 *  1Click reports a terminal status. Extracted from the React hook so the
 *  state machine is testable without a DOM. */
export function startStatusPoller(
  depositAddress: string,
  intervalMs: number,
  callbacks: PollerCallbacks,
  /** Injectable for tests; defaults to `fetchExecutionStatus`. */
  fetcher: (addr: string) => Promise<FetchStatusResult> = fetchExecutionStatus,
): PollerHandle {
  let cancelled = false;
  let settled = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const cancel = () => {
    cancelled = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = async () => {
    if (cancelled || settled) return;
    try {
      const { status } = await fetcher(depositAddress);
      if (cancelled) return;
      callbacks.onStatus(status);
      if (isTerminal(status)) {
        settled = true;
        callbacks.onSettled(status);
        cancel();
      }
    } catch (err) {
      if (cancelled) return;
      callbacks.onError(err instanceof Error ? err.message : String(err));
    }
  };

  void tick();
  timer = setInterval(() => void tick(), intervalMs);

  return { cancel };
}
