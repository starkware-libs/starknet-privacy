# Discovery Service Specifications

This folder contains the design specifications for the Privacy Pool Discovery Service.

## Spec Files

| File | Description |
|------|-------------|
| [01-summary.md](01-summary.md) | High-level overview of the discovery service's purpose and hybrid cache/RPC architecture. |
| [02-context-and-requirements.md](02-context-and-requirements.md) | Storage-based discovery model, functional requirements for note discovery, and key handling constraints. |
| [03-evolution-path.md](03-evolution-path.md) | Progression from naive contract calls to the recommended hot indexed cache with RPC fallback. |
| [04-proposed-architecture.md](04-proposed-architecture.md) | Component breakdown (API, engine, cache, indexer, RPC adapter) and data flow overview. |
| [05-security-considerations.md](05-security-considerations.md) | Key exposure mitigation, DoS protection, input validation, and privacy model assumptions. |
| [06-api-design.md](06-api-design.md) | HTTP endpoints for unified incoming sync, outgoing sync, and history; cursors, block references, and request/response formats. |
| [07-rpc-batching.md](07-rpc-batching.md) | Strategies for parallelizing and batching RPC calls across channels and subchannels. |
| [08-error-handling.md](08-error-handling.md) | Error response format, error codes with HTTP statuses, and client retry guidance. |
| [09-storage-slot-calculation.md](09-storage-slot-calculation.md) | Requirements for computing Cairo storage slots and associated engineering overhead. |
| [10-contract-versioning.md](10-contract-versioning.md) | Handling proxy contract upgrades, layout version tracking, and failure modes. |
| [11-reorg-handling.md](11-reorg-handling.md) | Chain reorganization detection, rollback strategy, and request handling during reorgs. |
| [12-key-management.md](12-key-management.md) | Per-request key model rationale and why persistent key storage is not recommended. |
| [13-alternative-data-sources.md](13-alternative-data-sources.md) | Trade-offs of using contract events or Apibara instead of direct storage access. |
| [14-implementation-details.md](14-implementation-details.md) | SQLite store design, Rust/Tokio/Axum stack, logging, and packaging requirements. |
| [15-rpc-backend-configuration.md](15-rpc-backend-configuration.md) | Single RPC endpoint model, health monitoring, and failover configuration. |
| [16-operational-monitoring.md](16-operational-monitoring.md) | Health and status endpoints, service level objectives, and alerting thresholds. |
| [17-cold-start-and-backfill.md](17-cold-start-and-backfill.md) | Behavior during cache backfill, snapshot import/export, and recovery time considerations. |
| [18-configuration.md](18-configuration.md) | Layered configuration system (env var > config file > code default), TOML format, and env var overrides. |
| [19-scaling-and-capacity.md](19-scaling-and-capacity.md) | Bottleneck analysis, capacity estimates, RPC node comparison, scaling strategy, and validated default config. |

## See also

- [Discovery service README](../../../crates/discovery-service/README.md) — implementation, API endpoints, and integration tests
