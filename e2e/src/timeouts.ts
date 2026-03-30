/** Shared E2E test timeouts (milliseconds). */
export const E2E_TIMEOUTS = {
  /** Vitest hook timeout (beforeAll / afterAll). */
  hook: 300_000,
  /** Vitest per-test timeout. */
  test: 180_000,
  /** Default timeout for waitForLog / waitForNewLog calls. */
  indexerLog: 15_000,
  /** Timeout when waiting for a child process to exit after SIGINT. */
  processExit: 10_000,
} as const;
