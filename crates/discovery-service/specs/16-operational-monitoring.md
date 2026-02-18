# 16. Operational Monitoring

## 16.1 Health Endpoint

`GET /health`

**Returns:**

```json
{
  "status": "healthy",
  "indexed_head": {
    "block_number": 123456,
    "block_hash": "0x...",
    "timestamp": 1704067200
  },
  "chain_head": {
    "block_number": 123457,
    "block_hash": "0x..."
  },
  "blocks_behind": 1,
  "rpc_status": "healthy",
  "backfill_in_progress": false
}
```

**Status values:**

- `healthy` - Indexer is within acceptable lag.
- `degraded` - Indexer is behind but operational.
- `unhealthy` - Indexer is significantly behind or RPC is unavailable.

## 16.2 Status Endpoint

`GET /status`

**Returns detailed operational statistics:**

```json
{
  "uptime_seconds": 86400,
  "indexed_blocks": 123456,
  "total_storage_entries": 5000000,
  "database_size_bytes": 1073741824,
  "requests_served": 100000,
  "rpc_fallback_count": 150,
  "reorgs_handled": 3
}
```

## 16.3 Service Level Objective

**SLO:** Indexer must be within 1 block of chain head 99.9% of the time.

**Monitoring should alert when:**

- Indexer falls more than 1 block behind for more than 30 seconds.
- RPC becomes unavailable.
- Reorg handling takes longer than expected.

## 16.4 Future Enhancements

Not included in initial implementation:

- Prometheus metrics export.
- Distributed tracing.
- Detailed cache hit/miss ratios (not applicable - cache misses trigger full RPC fallback).
