/**
 * Vitest setup file — runs in each forked worker before tests.
 *
 * The `starknet-devnet` npm package registers a global `uncaughtException`
 * handler that calls `process.exit(1)` without logging the error. In vitest's
 * forked workers, `process.exit` is overridden to throw, which kills the
 * worker and swallows the original error.
 *
 * This setup installs a handler BEFORE the devnet package to ensure the
 * actual error is logged. Node.js calls `uncaughtException` handlers in
 * registration order, so ours fires first.
 */

process.on("uncaughtException", (error) => {
  console.error("[vitest-setup] uncaughtException:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[vitest-setup] unhandledRejection:", reason);
});
