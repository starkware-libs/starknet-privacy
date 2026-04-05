# E2E Scripts

## Integration Environment Setup

Setup scripts deploy contracts to the integration Starknet environment. Each script is **idempotent** — it skips already-declared classes and already-deployed contracts. Run them in order since later scripts depend on addresses from earlier ones.

### Prerequisites

```bash
# Build contract artifacts
cd e2e/vesu-contracts && scarb build       # MockAsset, Vesu Pool, PoolFactory, VToken, Oracle, mock oracles
scarb build                                 # Privacy pool + VesuLendingHelper (from repo root)
```

Note: `vesu-contracts/` requires Scarb 2.11.4 (pinned in its `.tool-versions`). The repo root uses Scarb 2.17.0-rc.4.

### Setup order

Run from `e2e/` with `.env` populated (RPC_URL, ACCOUNTS, etc.):

```bash
# 1. Deploy shared test tokens (USD + BTC)
npm run setup-tokens
# → outputs USD_TOKEN_ADDRESS, BTC_TOKEN_ADDRESS — add to .env

# 2. Deploy Vesu lending infrastructure
npm run setup-vesu
# → outputs VESU_POOL_ADDRESS, VESU_ORACLE_ADDRESS, USD_VTOKEN_ADDRESS, etc. — add to .env

# 3. Deploy VesuLendingHelper (requires privacy pool artifacts from `scarb build`)
npm run setup-vesu-helper
# → outputs VESU_LENDING_HELPER_ADDRESS — add to .env
```

After each script, copy the printed env vars into `e2e/.env`. See `.env.example` for the full list.

### Idempotency and re-runs

- Class declarations and UDC deploys are fully idempotent (skip if already on-chain)
- Oracle and pool creation use `deploy_syscall` with deterministic addresses — they can't be re-created from the same factory. Set `VESU_ORACLE_ADDRESS` and `VESU_POOL_ADDRESS` in `.env` to skip these steps on re-run
- Liquidity seeding and price setting always run (safe to repeat)

### Script details

| Script              | What it does                                                                                                         | Depends on                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `setup-tokens`      | Declares + deploys MockAsset (minimal ERC-20 with `mint`), deploys USD and BTC instances                             | `vesu-contracts/` build artifacts                                           |
| `setup-vesu`        | Declares Vesu classes, deploys PoolFactory + mock oracles, creates Oracle + Pool with USD/BTC pairs, seeds liquidity | `vesu-contracts/` build artifacts, `USD_TOKEN_ADDRESS`, `BTC_TOKEN_ADDRESS` |
| `setup-vesu-helper` | Declares + deploys stateless VesuLendingHelper                                                                       | Privacy pool build artifacts (`target/dev/`)                                |

### Shared helpers (`helpers.ts`)

All setup scripts import from `helpers.ts`:

- `declareClass` — idempotent class declaration with automatic `l1_data_gas` scaling for large contracts
- `deployDeterministic` — UDC deploy with precomputed address check
- `executeAndWait` — execute + wait for receipt + assert success
- `setupAdmin` — creates provider + admin account from env vars

---

## Load Testing Scripts

## Scripts

### `pull-env.ts`

Pulls environment variables from the Vercel preview environment and writes a
local `.env` file with backend URLs rewritten for direct access.

```bash
npm run pull-env
```

**What it does:**

1. Runs `npx vercel pull --yes --environment=preview` (appends `--token` if `VERCEL_TOKEN` is set)
2. Reads `.vercel/.env.preview.local`
3. Extracts `VITE_*` and `WS_URL` lines, strips surrounding quotes from values
4. Rewrites backend URLs using `BACKEND_*` vars:
   - `VITE_INDEXER_URL` → `BACKEND_INDEXER_URL`
   - `VITE_PROVING_SERVICE_URL` → `BACKEND_PROVER_URL`
   - `VITE_RPC_URL` → `BACKEND_RPC_URL` + path (strips `/api` prefix)
5. Writes to `.env` (override with `OUT_FILE` env var)

**Requirements:**

- Vercel CLI authentication, or `VERCEL_TOKEN` env var
- `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` env vars (or a linked Vercel project via `.vercel/project.json`)


### `load-test-discovery.ts`

Hammers the discovery service with concurrent `discoverNotes()` calls.
Measures per-call latency, pagination round trips, and note counts.

```
npm run load-test-discovery -- --threads 4 --duration 60
npm run load-test-discovery -- --threads 8 --duration 30 --account alice --warmup 5 --json > results/run.json
```

**Flags:**

- `--threads <n>` — concurrent workers (default: 4)
- `--duration <seconds>` — run length (default: 60)
- `--account <name>` — account from ACCOUNTS env var (default: alice)
- `--warmup <seconds>` — discard stats from warmup period (default: 3)
- `--json` — emit structured JSON to stdout instead of human-readable output

**Pagination tracking:** wraps `globalThis.fetch` to count POST requests to
`/v1/sync/incoming_state`, giving visibility into how many pagination round
trips each `discoverNotes()` call requires.

### `batch-operations.ts`

Creates many notes via chunked deposits or transfers. Used to build up pool
state before load testing.

```
npm run batch-operations -- --mode deposit --count 500
npm run batch-operations -- --mode transfer --count 25 --recipient Charlie --amount 10
```

## Running a concurrency sweep

Save JSON results per thread count and compile a summary table:

```bash
cd e2e
for threads in 1 4 8 16 32 64 128; do
  echo "Running $threads threads..."
  npm run load-test-discovery -- --threads $threads --duration 30 --json 2>/dev/null \
    | sed -n '/^{/,/^}/p' > results/juno-0cache-${threads}t.json
done
```

Print results:

```bash
python3 -c "
import json
print(f\"{'Threads':>8} {'Calls':>6} {'Mean':>8} {'Median':>8} {'P95':>8} {'Min':>8} {'Max':>8} {'Errors':>7} {'Notes/call':>10}\")
print('-' * 85)
for t in [1, 4, 8, 16, 32, 64, 128]:
    with open(f'results/juno-0cache-{t}t.json') as f:
        d = json.load(f)
    s, l = d['summary'], d['summary']['latency']
    print(f\"{t:>8} {s['totalCalls']:>6} {l['mean']:>7}ms {l['median']:>7}ms {l['p95']:>7}ms {l['min']:>7}ms {l['max']:>7}ms {s['errorCount']:>7} {s['avgNotesPerCall']:>10}\")
"
```

## Methodology

### Phase A — Baseline

Single worker, current state. Establishes floor latency with zero contention.

### Phase B — State size sensitivity

Use `batch-operations.ts` to create accounts with varying note counts.
Run at 1 and 4 workers per state size. Produces latency-vs-state-size curve.

### Phase C — Concurrency sweep

Fix state size. Sweep workers: 1, 4, 8, 16, 32, 64, 128, 256, 512.
Isolates concurrency scaling behavior. Increase until errors or timeouts appear.

### Phase D — Config tuning

Only after B+C reveal the bottleneck. Adjust `server_budget`, `max_batch_size`,
or `max_concurrent_requests` via discovery-service ConfigMap or env vars.

## Fetching Disk IOPS Metrics

GCP hypervisor-level disk metrics are available without any agent. They have
60-second granularity and 6-week retention.

### Prerequisites

```bash
gcloud auth login
# Verify access:
gcloud projects describe starkware-dev
```

### 1. Find the GKE node instance IDs

```bash
# Which node runs each pod?
kubectl get pods -n privacy-starknet-pathfinder -o wide

# Get the GCE instance ID from the node's provider ID:
kubectl get node <NODE_NAME> -o jsonpath='{.spec.providerID}'
# Output: gce://starkware-dev/<zone>/<node-name>

# Get the numeric instance ID:
gcloud compute instances describe <NODE_NAME> \
  --zone=<ZONE> --project=starkware-dev --format="value(id)"
```

### 2. Find the PVC device name

The data disk appears as a PVC in GCP metrics, not as a block device path.

```bash
kubectl get pvc -n privacy-starknet-pathfinder
# NAME              VOLUME                                     CAPACITY
# juno-data         pvc-575bd535-...                            50Gi
# pathfinder-data   pvc-730e2716-...                            1000Gi
```

The `VOLUME` column is the `device_name` in GCP metrics.

### 3. Query IOPS via Monitoring API

The `gcloud monitoring time-series` subcommand may not be available in all SDK
versions. Use the REST API directly:

```bash
TOKEN=$(gcloud auth print-access-token)
INSTANCE_ID="<numeric instance ID>"
DEVICE_NAME="<pvc-... from step 2>"
START="2026-03-03T09:00:00Z"  # adjust to bracket your load test
END="2026-03-03T18:00:00Z"

# Read IOPS (60s ALIGN_RATE = ops/sec):
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://monitoring.googleapis.com/v3/projects/starkware-dev/timeSeries?\
filter=metric.type%3D%22compute.googleapis.com%2Finstance%2Fdisk%2Fread_ops_count%22\
%20AND%20resource.labels.instance_id%3D%22${INSTANCE_ID}%22\
%20AND%20metric.labels.device_name%3D%22${DEVICE_NAME}%22\
&interval.startTime=${START}&interval.endTime=${END}\
&aggregation.alignmentPeriod=60s&aggregation.perSeriesAligner=ALIGN_RATE"

# Write IOPS — same query, replace read_ops_count with write_ops_count.
```

### 4. Summarize results

Pipe the JSON output through a summary script:

```bash
curl -s ... | python3 -c "
import json, sys
data = json.load(sys.stdin)
for ts in data.get('timeSeries', []):
    points = ts.get('points', [])
    vals = [p['value']['doubleValue'] for p in points]
    non_zero = [v for v in vals if v > 0]
    print(f'Total points: {len(vals)}, non-zero: {len(non_zero)}')
    if non_zero:
        print(f'Max: {max(non_zero):.1f} IOPS, Avg (non-zero): {sum(non_zero)/len(non_zero):.1f}')
    top = sorted([(p['interval']['endTime'], p['value']['doubleValue']) for p in points], key=lambda x: -x[1])[:10]
    for t, v in top:
        print(f'  {t}: {v:.1f} IOPS')
"
```

### Current reference values

| Node       | Metric | Peak IOPS | Context                        |
| ---------- | ------ | --------- | ------------------------------ |
| Juno       | read   | 32.8      | 1125 notes, 64 threads, pd-ssd |
| Juno       | write  | 10.1      | same                           |
| Pathfinder | read   | 0.7       | 1125 notes, 32 threads, pd-ssd |
| Pathfinder | write  | 13.2      | same                           |

Both nodes serve reads almost entirely from cache at this state size.
