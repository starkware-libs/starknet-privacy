# 19. Scaling and Capacity Planning

## 19.0 Scope, Methodology, and Evidence Levels

This document summarizes load-test work from the project's capacity-testing iterations.

Workload and harness:

- Discovery calls use `discoverNotes()` load loops from `e2e/scripts/load-test-discovery.ts`.
- Most runs use a single-account workload with 1125 notes and one pagination round trip at high budget.
- Structured run outputs were captured for each benchmark run.

Methodology normalization used in this spec:

- Throughput is reported as `req/s = totalCalls / 30`.
- Latency is the mean latency reported in each run summary.
- The harness records post-warmup calls, but this spec fixes denominator to 30s for consistent cross-phase comparison.

### 19.0.1 Optimization Objective

Discovery tuning in these experiments is latency-first:

- Keep each discovery operation to one (or very few) API queries by setting `server_budget` high enough to avoid pagination for the expected state size.
- Keep backend round-trip cost low by using RPC batch requests (`max_batch_size`) large enough to amortize per-request overhead.
- Throttle RPC fan-out (`max_concurrent_requests`) to avoid overdriving backend internals and increasing queueing/collision contention.

Capacity interpretation note:

- A discovery request can translate to up to roughly `2 x discovered_notes` storage reads.
- At `1125` discovered notes, that is up to about `2250` storage reads per discovery request.
- At `7.0 req/s`, this corresponds to about `15,750` storage reads/s.
- At `8.9 req/s`, this corresponds to about `20,025` storage reads/s.
- This is why API-level req/s can look modest while backend storage-read throughput is still high.

Benchmark baseline settings used in most runs (not necessarily code defaults):

```toml
[rpc]
max_concurrent_requests = 10
max_batch_size = 256
connect_timeout = 60
request_timeout = 30

[limits]
server_budget = 10000
```

## 19.1 Bottleneck Analysis

The RPC node is the primary bottleneck. Both Juno and Pathfinder hit internal serialization ceilings well before exhausting CPU, disk, or network. Under peak load on n2-highcpu-16: CPU <37%, disk IOPS <32 (on pd-ssd capable of ~100K), network <6 MB/s.

**Juno** — trie lock contention. Concurrent `getStorageAt` calls contend on a `sync.RWMutex` in `diffLayer.node()`. Go's RWMutex serializes under high contention. No shared trie node cache across requests — each call traverses the full 251-bit Merkle-Patricia trie. Used only 2.2/16 cores under load. The `db-cache-size` setting helps by caching upper trie nodes, reducing lock acquisitions.

**Pathfinder** — SQLite WAL checkpoint blocking. The `getStorageAt` path has no application-level locks (clean `pool.get()` → read-only transaction → SELECT). Contention is inside SQLite: with default `wal_autocheckpoint` (1000 pages), any reader can trigger a passive checkpoint during `sqlite3_step()`, blocking other readers. Write IOPS of 9-13/s during read-only tests correlate with checkpoint activity. Read connections also lack `busy_timeout`, so `SQLITE_BUSY` fails immediately. Used 5.9/16 cores under load. The `--rpc.batch-concurrency-limit` (default 1) controls intra-batch parallelism; increasing it pushes more CPU but worsens checkpoint collisions.

**Cache effectiveness is limited** for discovery workloads: each client queries keys specific to their account with little overlap between connections. Per-connection caches only help if they cover the entire StarkNet state, which is impractical. OS page cache (via `mmap_size`) is the better lever since it's shared.

**Scaling outlook:** Vertical scaling of the RPC node yields diminishing returns due to internal serialization. Pathfinder SQLite PRAGMA tuning (`wal_autocheckpoint=0`, `mmap_size`) may help but is unvalidated. The proven path for higher throughput is horizontal scaling: multiple RPC nodes behind a load balancer.

**Discovery service scaling:** The service is stateless, so the RPC node is the primary bottleneck. However, discovery itself hit 76.7% CPU on n2-standard-4 (4 vCPUs) during high-concurrency tests. If the RPC layer is scaled horizontally, the discovery service may become CPU-bound and require more cores or additional replicas.

## 19.2 Test Matrix and Topologies

| Phase | Primary question | Backend(s) | Topology summary | Primary dataset |
|---|---|---|---|---|
| A | Baseline latency | Juno, Pathfinder | n2-standard-4 class | Baseline phase run summaries |
| B | Pagination sensitivity (`server_budget`) | Juno | n2-standard-4 class | Budget sweep run summaries |
| C | Concurrency sweep | Juno, Pathfinder | n2-standard-4 class | Concurrency sweep run summaries |
| D | Config tuning grid (`c x b`) | Juno, Pathfinder | n2-standard-4 class | Config-grid run summaries |
| E | Effect of larger RPC node | Juno | highcpu isolated + colocated sensitivity run | Highcpu Juno run summaries |
| F | Cache sensitivity (`db-cache-size=0`) | Juno | highcpu | Juno zero-cache run summaries |
| G | Pathfinder highcpu scaling and tuning | Pathfinder | highcpu (multiple placements/configs) | Pathfinder highcpu run summaries |

## 19.3 Baseline Capacity (n2-standard-4)

Measured from the baseline/concurrency sweep run summaries.

| Threads | Juno throughput / mean latency | Pathfinder throughput / mean latency |
|---|---|---|
| 1 | 0.9 req/s / 0.93s | 0.8 req/s / 1.03s |
| 16 | 5.6 req/s / 2.37s | 4.1 req/s / 3.50s |
| 32 | 6.8 req/s / 4.04s | 6.3 req/s / 4.28s |
| Peak | 7.0 req/s @ 64t / 7.03s | 6.3 req/s @ 32t / 4.28s |
| 128 | 5.4 req/s / 13.80s | 0.1 req/s / 8.30s |

Key observations (`Measured`):

- Baseline single-user latency is similar (~1s) for both backends.
- On this topology, Juno peaks higher, while Pathfinder saturates earlier.
- Both backends show zero errors in these runs.

Scope note:

- These conclusions apply to this workload and this machine class, not universally.

## 19.4 Pagination Sensitivity (Phase B, Juno)

Measured from the budget sweep run summaries.

### 1 thread (latency-focused)

| Server budget | Mean round trips | Mean latency | Throughput |
|---|---|---|---|
| 500 | 6.0 | 1.824s | 0.4 req/s |
| 1000 | 3.0 | 1.549s | 0.5 req/s |
| 2000 | 2.0 | 1.257s | 0.5 req/s |
| 5000 | 1.0 | 0.957s | 0.9 req/s |
| 10000 | 1.0 | 0.931s | 0.9 req/s |

### 32 threads (contention-focused)

| Server budget | Mean round trips | Mean latency | Throughput |
|---|---|---|---|
| 500 | 10.5 | 3.948s | 5.5 req/s |
| 1000 | 6.0 | 3.958s | 5.6 req/s |
| 2000 | 5.1 | 4.105s | 5.6 req/s |
| 5000 | 1.0 | 4.142s | 5.3 req/s |
| 10000 | 1.0 | 4.036s | 6.8 req/s |

Interpretation:

- `Measured`: lower budgets increase pagination round trips and hurt single-user latency.
- `Measured`: under contention, queueing dominates latency, but lower budget still reduces throughput.

## 19.5 Config Tuning (Phase D)

Measured from the config-grid run summaries.

### Juno (fixed 64 threads)

| `max_concurrent_requests` | `max_batch_size` | Throughput | Mean latency |
|---|---|---|---|
| 10 | 64 | 4.9 req/s | 10.747s |
| 10 | 128 | 5.3 req/s | 9.098s |
| 10 | 256 | 7.0 req/s | 7.029s |
| 10 | 512 | 6.2 req/s | 8.115s |
| 20 | 256 | 5.8 req/s | 8.112s |
| 50 | 256 | 6.7 req/s | 7.524s |

### Pathfinder (fixed 32 threads)

| `max_concurrent_requests` | `max_batch_size` | Throughput | Mean latency |
|---|---|---|---|
| 10 | 64 | 4.1 req/s | 6.524s |
| 10 | 128 | 4.7 req/s | 5.145s |
| 10 | 256 | 6.3 req/s | 4.278s |
| 10 | 512 | 3.1 req/s | 7.473s |
| 20 | 256 | 4.5 req/s | 5.510s |
| 50 | 256 | 3.9 req/s | 5.998s |

Conclusion for this tested grid (`Measured`):

- `c=10, b=256` is the best-performing baseline on both backends.
- No tested alternative dominated the baseline on both throughput and latency.

## 19.6 High-CPU Experiments (Phases E/F/G)

### 19.6.1 Juno highcpu isolated (Phase E)

Measured from the isolated highcpu Juno run summaries.

| Threads | Throughput | Mean latency |
|---|---|---|
| 1 | 0.8 req/s | 1.043s |
| 16 | 6.1 req/s | 2.142s |
| 32 (peak) | 7.2 req/s | 3.735s |
| 64 | 2.8 req/s | 21.885s |
| 128 | 5.9 req/s | 14.150s |

Notes:

- `Measured`: peak in this isolated run is around 32 threads.
- `Measured`: throughput is non-monotonic at very high thread counts (short-run contention effects).

Colocated sensitivity run:

- The colocated 128-thread run records 356 calls, which is 11.9 req/s under the fixed 30s denominator.
- Using post-warmup effective time yields 14.2 req/s for the same run.

### 19.6.2 Juno cache sensitivity (Phase F)

Measured from the zero-cache Juno run summaries.

| Threads | Throughput | Mean latency |
|---|---|---|
| 1 | 0.7 req/s | 1.205s |
| 16 (peak) | 4.4 req/s | 3.317s |
| 32 | 4.1 req/s | 6.724s |
| 64 | 3.3 req/s | 11.637s |

Interpretation:

- 0-cache peak throughput (~4.4 req/s) is roughly half of default-cache highcpu peak levels reported in this project.
- Trie lock/cache-path effects likely explain why extra cores do not translate linearly.

### 19.6.3 Pathfinder highcpu baseline and tuning (Phase G)

Baseline measured from the Pathfinder highcpu run summaries.

| Threads | Throughput | Mean latency |
|---|---|---|
| 1 | 0.8 req/s | 1.209s |
| 16 | 7.7 req/s | 1.890s |
| 32 (peak) | 8.9 req/s | 3.072s |
| 64 | 8.3 req/s | 5.937s |
| 128 | 8.1 req/s | 10.488s |
| 512 | 2.7 req/s | 18.657s |

Extreme-concurrency tuning reruns (`Measured`):

| Config label | Run set (256t / 512t) | 256t throughput | 512t throughput |
|---|---|---|---|
| c10, bcl10, rpc1024 | Baseline high-concurrency reruns | 4.5 req/s | 2.4 req/s |
| c10, bcl16, rpc2048 | Higher batch-concurrency reruns | 5.2 req/s | 1.0 req/s |
| c48, bcl16, rpc2048 | Higher discovery concurrency reruns | 3.7 req/s | 1.2 req/s |
| c10, bcl16, rpc4096 | Higher RPC-connection reruns | 3.2 req/s | 1.5 req/s |

Interpretation:

- Higher parallelism can improve some single points (for example 256t) but worsen tail behavior at 512t.
- This behavior is likely driven by batch concurrency and DB/pool contention interactions.

## 19.7 Bottleneck Interpretation by Topology

| Topology slice | Dominant bottleneck interpretation | Confidence |
|---|---|---|
| n2-standard-4 baseline (Phases A-D) | RPC backend behavior dominates overall throughput envelope | `Measured` |
| Juno highcpu isolated (Phase E) | discovery-service CPU can become the limiting factor when only RPC capacity is increased | Measured + interpretation |
| Pathfinder highcpu (Phase G) | backend internal contention still shapes high-concurrency tail behavior | Measured + interpretation |

Important:

- There is no single bottleneck conclusion valid for all placements. Bottleneck shifts with topology.

## 19.8 Capacity Envelopes and Recommendations

### Envelope A: n2-standard-4 class (reference baseline)

- Juno: up to ~7.0 req/s peak for this workload, with strong latency growth past 32-64 threads.
- Pathfinder: up to ~6.3 req/s peak for this workload, with earlier saturation.

### Envelope B: highcpu experiments (sensitivity)

- Juno isolated highcpu: ~7.2 req/s peak in measured isolated sweep.
- Pathfinder highcpu: ~8.9 req/s peak with better high-thread graceful degradation than baseline pathfinder runs.

Operational recommendations:

- Keep benchmark baseline `c=10, b=256, budget=10000` as the default operating profile unless environment-specific tests show a better profile.
- Size `server_budget` so expected state fits in one pagination round trip where practical.
- Prefer large enough RPC batches to reduce per-call overhead, but keep RPC concurrency bounded to avoid backend overload.
- Evaluate capacity in both API req/s and estimated storage-read TPS (`up to 2 x notes x req/s`).
- Evaluate scaling decisions using the target production topology; do not extrapolate from mixed-placement runs.
- Treat SQLite PRAGMA or deep backend-internal tuning as follow-up validation work, not proven defaults.

## 19.9 Limitations

Known limitations:

- Single dominant workload shape (repeated `discoverNotes` pattern).
- Narrow state-size band (1125 notes) for most measurements.
- Limited cross-account access-pattern diversity.
