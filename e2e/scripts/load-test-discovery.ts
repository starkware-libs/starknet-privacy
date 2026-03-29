/**
 * Load test script: hammers the discovery service with concurrent discoverNotes calls.
 *
 * Spawns N concurrent workers that repeatedly call discoverNotes() for a given
 * account in a tight loop until the duration expires. Each call paginates
 * internally until all notes are discovered. Collects per-call response time
 * and pagination round-trip stats.
 *
 * Reads env vars:
 *   VITE_INDEXER_URL, VITE_POOL_ADDRESS, VITE_TOKEN_ADDRESS, ACCOUNTS
 *
 * CLI args:
 *   --threads <n>        Number of concurrent workers (default: 4)
 *   --duration <seconds> How long to run (default: 60)
 *   --account <name>     Account to test (default: alice)
 *   --warmup <seconds>   Discard stats from initial warmup period (default: 3)
 *   --json               Emit single JSON object to stdout instead of human-readable output
 *
 * Usage:
 *   npm run load-test-discovery -- --threads 4 --duration 60
 *   npm run load-test-discovery -- --threads 4 --json > results/run-001.json
 */

import { IndexerDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
interface AccountEntry {
  name: string;
  address: string;
  privateKey: string;
  viewingKey: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseIntArg(
  args: string[],
  flag: string,
  defaultValue: number,
): number {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return defaultValue;
  const value = parseInt(args[index + 1], 10);
  if (isNaN(value) || value <= 0) {
    console.error(`Invalid value for ${flag}: ${args[index + 1]}`);
    process.exit(1);
  }
  return value;
}

function parseStringArg(
  args: string[],
  flag: string,
  defaultValue: string,
): string {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return defaultValue;
  return args[index + 1];
}

function parseBooleanFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function findAccount(accounts: AccountEntry[], name: string): AccountEntry {
  const entry = accounts.find(
    (account) => account.name.toLowerCase() === name.toLowerCase(),
  );
  if (!entry)
    throw new Error(`Account "${name}" not found in ACCOUNTS env var`);
  return entry;
}

interface CallStats {
  startedAt: number;
  elapsed: number;
  noteCount: number;
  paginationRoundTrips: number;
  error: boolean;
}

let paginationCounter = 0;

function installFetchWrapper(indexerUrl: string): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function wrappedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      init?.method === "POST" &&
      url.includes(indexerUrl) &&
      url.includes("/v1/sync/incoming_state")
    ) {
      paginationCounter++;
    }
    return originalFetch.call(globalThis, input, init);
  };
}

function resetPaginationCounter(): void {
  paginationCounter = 0;
}

function readPaginationCounter(): number {
  return paginationCounter;
}

function percentile(sortedValues: number[], p: number): number {
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

function formatMs(milliseconds: number): string {
  return `${milliseconds.toFixed(0)}ms`;
}

async function worker(
  workerId: number,
  discovery: IndexerDiscoveryProvider,
  address: bigint,
  viewingKey: bigint,
  token: bigint,
  deadline: number,
  jsonMode: boolean,
  workerStats: CallStats[],
): Promise<void> {
  while (Date.now() < deadline) {
    const startedAt = Date.now();
    resetPaginationCounter();
    try {
      const result = await discovery.discoverNotes(address, viewingKey, {
        tokens: [token],
      });
      const elapsed = Date.now() - startedAt;
      const noteCount = result.notes.get(token)?.length ?? 0;
      const paginationRoundTrips = readPaginationCounter();
      workerStats.push({
        startedAt,
        elapsed,
        noteCount,
        paginationRoundTrips,
        error: false,
      });
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      const paginationRoundTrips = readPaginationCounter();
      workerStats.push({
        startedAt,
        elapsed,
        noteCount: 0,
        paginationRoundTrips,
        error: true,
      });
      if (!jsonMode) {
        console.error(
          `[worker-${workerId}] ERROR after ${formatMs(elapsed)}: ${error}`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const cliArgs = process.argv.slice(2);
  const numThreads = parseIntArg(cliArgs, "--threads", 4);
  const durationSeconds = parseIntArg(cliArgs, "--duration", 60);
  const accountName = parseStringArg(cliArgs, "--account", "alice");
  const warmupSeconds = parseIntArg(cliArgs, "--warmup", 3);
  const jsonMode = parseBooleanFlag(cliArgs, "--json");

  const indexerUrl = requireEnv("VITE_INDEXER_URL");
  const poolAddress = requireEnv("VITE_POOL_ADDRESS");
  const token = requireEnv("VITE_TOKEN_ADDRESS");
  const accounts: AccountEntry[] = JSON.parse(requireEnv("ACCOUNTS"));
  const account = findAccount(accounts, accountName);

  const address = BigInt(account.address);
  const viewingKey = BigInt(account.viewingKey);
  const tokenBigint = BigInt(token);

  installFetchWrapper(indexerUrl);
  const discovery = new IndexerDiscoveryProvider(indexerUrl, poolAddress);
  const startTimestamp = new Date().toISOString();
  const startMs = Date.now();
  const deadline = startMs + durationSeconds * 1000;
  const warmupDeadline = startMs + warmupSeconds * 1000;

  if (!jsonMode) {
    console.log(
      `Load test: ${numThreads} threads, ${durationSeconds}s duration, ${warmupSeconds}s warmup`,
    );
    console.log(`Indexer: ${indexerUrl}`);
    console.log(`Pool: ${poolAddress}`);
    console.log(`Account: ${account.name} (${account.address})\n`);
  }

  const allStats: CallStats[][] = Array.from({ length: numThreads }, () => []);

  await Promise.all(
    Array.from({ length: numThreads }, (_, workerId) =>
      worker(
        workerId,
        discovery,
        address,
        viewingKey,
        tokenBigint,
        deadline,
        jsonMode,
        allStats[workerId],
      ),
    ),
  );

  const flatStats = allStats.flat();
  const postWarmupStats = flatStats.filter(
    (stat) => stat.startedAt >= warmupDeadline,
  );
  const successfulCalls = postWarmupStats.filter((stat) => !stat.error);
  const errorCount = postWarmupStats.length - successfulCalls.length;
  const discardedWarmupCalls = flatStats.length - postWarmupStats.length;

  if (jsonMode) {
    emitJson({
      numThreads,
      durationSeconds,
      warmupSeconds,
      indexerUrl,
      poolAddress,
      account,
      startTimestamp,
      successfulCalls,
      errorCount,
      totalCalls: postWarmupStats.length,
      discardedWarmupCalls,
      rawCalls: postWarmupStats,
    });
  } else {
    emitHumanReadable({
      successfulCalls,
      errorCount,
      totalCalls: postWarmupStats.length,
      discardedWarmupCalls,
    });
  }
}

interface JsonOutputParams {
  numThreads: number;
  durationSeconds: number;
  warmupSeconds: number;
  indexerUrl: string;
  poolAddress: string;
  account: AccountEntry;
  startTimestamp: string;
  successfulCalls: CallStats[];
  errorCount: number;
  totalCalls: number;
  discardedWarmupCalls: number;
  rawCalls: CallStats[];
}

function emitJson(params: JsonOutputParams): void {
  const {
    numThreads,
    durationSeconds,
    warmupSeconds,
    indexerUrl,
    poolAddress,
    account,
    startTimestamp,
    successfulCalls,
    errorCount,
    totalCalls,
    discardedWarmupCalls,
    rawCalls,
  } = params;

  const latencyStats = computeLatencyStats(successfulCalls);
  const paginationStats = computePaginationStats(successfulCalls);
  const avgNotesPerCall =
    successfulCalls.length > 0
      ? successfulCalls.reduce((sum, stat) => sum + stat.noteCount, 0) /
        successfulCalls.length
      : 0;

  const output = {
    metadata: {
      timestamp: startTimestamp,
      threads: numThreads,
      durationSeconds,
      warmupSeconds,
      indexerUrl,
      poolAddress,
      account: { name: account.name, address: account.address },
    },
    summary: {
      totalCalls,
      successfulCalls: successfulCalls.length,
      errorCount,
      discardedWarmupCalls,
      latency: latencyStats,
      pagination: paginationStats,
      avgNotesPerCall: Math.round(avgNotesPerCall * 10) / 10,
    },
    rawCalls,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

interface HumanReadableParams {
  successfulCalls: CallStats[];
  errorCount: number;
  totalCalls: number;
  discardedWarmupCalls: number;
}

function emitHumanReadable(params: HumanReadableParams): void {
  const { successfulCalls, errorCount, totalCalls, discardedWarmupCalls } =
    params;

  console.log("\n=== Summary ===");
  console.log(`Total calls:     ${totalCalls}`);
  console.log(`Successful:      ${successfulCalls.length}`);
  console.log(`Errors:          ${errorCount}`);
  if (discardedWarmupCalls > 0) {
    console.log(`Warmup discarded: ${discardedWarmupCalls}`);
  }

  if (successfulCalls.length > 0) {
    const latencyStats = computeLatencyStats(successfulCalls);
    const paginationStats = computePaginationStats(successfulCalls);
    const noteCounts = successfulCalls.map((stat) => stat.noteCount);
    const avgNotes =
      noteCounts.reduce((acc, val) => acc + val, 0) / noteCounts.length;

    console.log(`\nLatency:`);
    console.log(`  Mean:   ${formatMs(latencyStats.mean)}`);
    console.log(`  Median: ${formatMs(latencyStats.median)}`);
    console.log(`  Min:    ${formatMs(latencyStats.min)}`);
    console.log(`  Max:    ${formatMs(latencyStats.max)}`);
    console.log(`  P95:    ${formatMs(latencyStats.p95)}`);
    console.log(`\nPagination round trips:`);
    console.log(`  Mean:   ${paginationStats.meanRoundTrips.toFixed(1)}`);
    console.log(`  Median: ${paginationStats.medianRoundTrips}`);
    console.log(`  Max:    ${paginationStats.maxRoundTrips}`);
    console.log(`\nAvg notes/call: ${avgNotes.toFixed(1)}`);
  }
}

interface LatencyStats {
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

function computeLatencyStats(successfulCalls: CallStats[]): LatencyStats {
  if (successfulCalls.length === 0) {
    return { mean: 0, median: 0, p95: 0, min: 0, max: 0 };
  }
  const latencies = successfulCalls
    .map((stat) => stat.elapsed)
    .sort((a, b) => a - b);
  const sum = latencies.reduce((acc, val) => acc + val, 0);
  return {
    mean: Math.round(sum / latencies.length),
    median: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    min: latencies[0],
    max: latencies[latencies.length - 1],
  };
}

interface PaginationStats {
  meanRoundTrips: number;
  medianRoundTrips: number;
  maxRoundTrips: number;
}

function computePaginationStats(successfulCalls: CallStats[]): PaginationStats {
  if (successfulCalls.length === 0) {
    return { meanRoundTrips: 0, medianRoundTrips: 0, maxRoundTrips: 0 };
  }
  const roundTrips = successfulCalls
    .map((stat) => stat.paginationRoundTrips)
    .sort((a, b) => a - b);
  const sum = roundTrips.reduce((acc, val) => acc + val, 0);
  return {
    meanRoundTrips: Math.round((sum / roundTrips.length) * 10) / 10,
    medianRoundTrips: percentile(roundTrips, 50),
    maxRoundTrips: roundTrips[roundTrips.length - 1],
  };
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
