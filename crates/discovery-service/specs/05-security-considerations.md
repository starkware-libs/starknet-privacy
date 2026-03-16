# 5. Security Considerations

## 5.1 Key Exposure in Transit and Memory

Keys are provided per request and not stored, but additional safeguards are required:

**Transit security:**

- All API endpoints MUST be served over TLS 1.3+.
- Clients SHOULD verify server certificates.

**Memory handling:**

- Decryption keys MUST be zeroed from memory after request processing completes. Implemented via `SecretFelt` wrapper (zeroize-on-drop, redacted Debug, no Copy/Serde).
- `viewing_key` and `channel_key` are typed as `SecretFelt` from API deserialization through hash/decryption primitives.
- Core dumps and swap SHOULD be disabled or encrypted in production deployments.

**Logging hygiene:**

- Structured logging MUST filter sensitive fields including `private_key` and decrypted note contents.
- Request/response logging MUST NOT include key material. `SecretFelt::Debug` prints `[REDACTED]`.

**Error sanitization:**

- Decryption errors MUST NOT leak channel indices or internal error details to the client. Details are logged server-side at `warn` level; the client receives a generic `DECRYPTION_FAILED` message.
- RPC/storage errors MUST NOT be forwarded verbatim. The client receives `Internal error`; details are logged server-side.

## 5.2 Timing and Side-Channel Attacks

Timing and side-channel attacks are out of scope for the initial implementation. Future enhancements may consider:

- Constant-time response padding.
- Obfuscating cache hit/miss timing.
- Rate limiting patterns that prevent activity correlation.

## 5.3 Denial of Service Mitigation

**Per-request budget:** The `max_reads` parameter limits work per request. This enables simple per-IP rate limiting at the infrastructure level.

**RPC fallback budget:** When the service falls back to RPC (during cold start or reorg), a stricter budget MUST apply to prevent amplification attacks. The fallback budget SHOULD be configurable and significantly lower than the cache-served budget.

**Rate limiting:** Per-IP rate limiting and `Retry-After` headers are handled at the reverse proxy / infrastructure level, not by the service itself.

### 5.3.1 Known Attack Vectors (audit 2026-02-04)

The following vectors have been identified and mitigated:

| Vector | Severity | Status |
|--------|----------|--------|
| Unbounded task spawning from `cursor.channels` / `cursor.subchannels` HashMaps — each entry spawns a tokio task, attacker can pack ~50K entries in a 2MB body | CRITICAL | mitigated by body size limit (C1) |
| No explicit request body size limit — Axum 2MB default is ~4000× larger than a legitimate request | CRITICAL | DONE — `DefaultBodyLimit` configurable via `max_request_body_bytes` (default 100KB) |
| No HTTP-level request timeout — slow RPC responses block worker threads up to 100min per request | HIGH | DONE — `TimeoutLayer` configurable via `api.request_timeout` (default 30s) |
| HashMap deserialization memory spike from large cursors | MEDIUM | mitigated by body size limit |
| `max_reads: 0` accepted, wastes snapshot creation | LOW | DONE — `min_server_budget()` clamp (minimum 67 with default config, derived from full discovery pipeline costs) |

## 5.4 Input Validation

The following request fields are validated by the service:

- **max_reads:** Must be within allowed bounds (default 50, max 100). Zero is currently accepted but wastes work.
- **last_known_block:** If provided, checked for canonical status (reorg detection). Returns `BLOCK_REORGED` if no longer canonical.
- **block_ref:** If provided, used as-is for querying. No separate existence check — an invalid hash surfaces as an RPC error.
- **cursor:** Structural validation via serde deserialization. Malformed JSON results in `INVALID_REQUEST`. **Note:** cursor HashMap sizes (`channels`, `subchannels`) are NOT validated — an attacker can submit arbitrarily large maps that spawn unbounded concurrent tasks. Size caps MUST be enforced before task spawning.
- **recipient_address:** Accepted as a Felt value without format validation.
- **viewing_key:** Deserialized as `SecretFelt` (transparent serde, zeroized on drop). Validated against the registered public key: the service derives the public key from the viewing key via EC scalar multiplication and checks it against the on-chain registered public key for the request's address. Returns `INVALID_REQUEST` if mismatched. Skipped for unregistered addresses (zero public key).

## 5.5 Privacy Model

Users trust the service operator. The operator can observe:

- Which recipients are active and when.
- How many channels, subchannels, and notes each recipient has.
- Token addresses used per channel.
- Timing of sync activity.

This metadata exposure is accepted given the trust model. Users requiring stronger privacy guarantees should run their own instance.
