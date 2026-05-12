import { useEffect, useRef, useState } from "react";

type Options = {
  intervalMs: number;
  /** When true, the next tick is skipped (e.g. a tx is in flight). */
  paused: boolean;
  refresh: () => Promise<unknown> | unknown;
};

/**
 * Periodic background refresh for the wallet's discovery sweep. Three rules:
 *
 *   1. Pause when the browser tab is hidden — the Page Visibility API tells us
 *      the user can't see the result anyway, and OHTTP / proving relays bill
 *      per request. We still fire one refresh on visibility-restore so the
 *      stale gap is bounded by the interval, not "until the user looks again".
 *   2. Pause while `paused` is true. Post-tx refresh is already handled by
 *      `useTransactions.onSettled`; running a concurrent discovery sweep
 *      races with that one and just doubles cost without changing the result.
 *   3. Surface `lastRefreshAt` so the UI can render "Updated Ns ago" — the
 *      indicator is the contract: if you don't render it, users have no
 *      visible signal that polling exists.
 */
export function useAutoRefresh({ intervalMs, paused, refresh }: Options): {
  lastRefreshAt: number | null;
} {
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);

  // Stable refs let the interval callback see the latest paused flag and
  // refresh function without re-creating the timer every render.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const inFlightRef = useRef(false);

  useEffect(() => {
    async function tick() {
      if (pausedRef.current) return;
      if (inFlightRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;
      inFlightRef.current = true;
      try {
        await refreshRef.current();
        setLastRefreshAt(Date.now());
      } finally {
        inFlightRef.current = false;
      }
    }

    const intervalId = window.setInterval(tick, intervalMs);

    function onVisible() {
      if (!document.hidden) void tick();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return { lastRefreshAt };
}

/** "4s ago" / "1m ago" formatter for the refresh indicator. */
export function formatAge(timestampMs: number | null): string {
  if (timestampMs === null) return "—";
  const ageSecs = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (ageSecs < 60) return `${ageSecs}s ago`;
  const ageMins = Math.floor(ageSecs / 60);
  if (ageMins < 60) return `${ageMins}m ago`;
  return `${Math.floor(ageMins / 60)}h ago`;
}
