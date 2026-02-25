# 12. Key Management and Security Posture

## 12.1 Per-Request Keys are the Default

- Keys are supplied with each sync request as `viewing_key` (typed `SecretFelt`).
- The service decrypts channels and notes and returns decrypted data.
- Keys are not stored.
- Keys are zeroed from memory after request processing via `SecretFelt` (zeroize-on-drop). The `SecretFelt` wrapper:
  - Implements `Deref<Target=Felt>` for transparent use
  - Excludes `Copy` (prevents silent copies of secrets)
  - Excludes direct `Serde` (uses explicit serde helpers at system boundaries)
  - Prints `[REDACTED]` for `Debug` (prevents accidental logging)
- `SecretFelt` is used from API deserialization through `channel_key` in cursors, hash functions, and decryption primitives.

This avoids persistent sensitive material in infrastructure.

Public keys fetched from the contract are cached in a lock-free concurrent cache (moka, default 10K entries) to avoid redundant RPC calls. Keyed by `(contract_address, user_address)`. Public keys are immutable once registered, so cache entries never go stale. Zero (unregistered) values are not cached.

## 12.2 Persistent Key Storage is an Option, but Not Recommended

Persistent key storage introduces disadvantages:

- **Security risk:** Long-lived secrets become high-value targets.
- **Legal and compliance risk:** Custody of secrets increases obligations.
- **Operational complexity:** Key replication, rotation, and secure storage across replicas.
- **Authentication complexity:** API requests must be strongly authenticated and authorized, and misuse prevention becomes critical.

Given the discovery service can operate with per-request keys, permanent storage is not justified.
