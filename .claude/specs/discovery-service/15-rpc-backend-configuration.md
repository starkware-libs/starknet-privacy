# 15. RPC Backend Configuration

## 15.1 Single RPC Endpoint Model

The indexer uses a single RPC endpoint to avoid inconsistencies that can arise from querying a pool of nodes at different sync states.

**Recommended configurations:**

- **Production:** Local Starknet node or trusted provider.
- **Development:** Public RPC endpoint with rate limit awareness.

## 15.2 RPC Health Monitoring

The service MUST monitor RPC health:

**Lag detection:** Compare the latest block timestamp from RPC against current wall-clock time. If lag exceeds threshold (configurable, default 60 seconds), consider the RPC unhealthy.

**Failover:** If a backup RPC endpoint is configured and the primary is unhealthy:

1. Log warning and switch to backup.
2. Continue monitoring primary for recovery.
3. Optionally switch back when primary recovers (configurable).

**No pooling:** Do not use a pool of RPC nodes for indexing. State inconsistencies between nodes can cause subtle bugs in reorg detection and cache coherency.

## 15.3 RPC Integrity

When using local nodes or trusted providers, RPC response integrity is assumed. Cross-provider validation is not implemented in the initial version.
