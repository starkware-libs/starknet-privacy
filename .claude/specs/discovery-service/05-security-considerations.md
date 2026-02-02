# 5. Security Considerations

## 5.1 Key Exposure in Transit and Memory

Keys are provided per request and not stored, but additional safeguards are required:

**Transit security:**

- All API endpoints MUST be served over TLS 1.3+.
- Clients SHOULD verify server certificates.

**Memory handling:**

- Decryption keys MUST be zeroed from memory after request processing completes.
- Core dumps and swap SHOULD be disabled or encrypted in production deployments.

**Logging hygiene:**

- Structured logging MUST filter sensitive fields including `private_key` and decrypted note contents.
- Request/response logging MUST NOT include key material.

## 5.2 Timing and Side-Channel Attacks

Timing and side-channel attacks are out of scope for the initial implementation. Future enhancements may consider:

- Constant-time response padding.
- Obfuscating cache hit/miss timing.
- Rate limiting patterns that prevent activity correlation.

## 5.3 Denial of Service Mitigation

**Per-request budget:** The `max_reads` parameter limits work per request. This enables simple per-IP rate limiting at the infrastructure level.

**RPC fallback budget:** When the service falls back to RPC (during cold start or reorg), a stricter budget MUST apply to prevent amplification attacks. The fallback budget SHOULD be configurable and significantly lower than the cache-served budget.

**Rate limiting:** Per-IP rate limiting is required. Implementation details are left to the deployment configuration.

## 5.4 Input Validation

All request fields MUST be validated:

- **block_ref:** Must be a valid block hash. The referenced block must exist and have block number greater than `last_synced_block`. Invalid or unknown block hashes result in an error.
- **last_synced_block:** Must be a valid block hash or empty string for initial sync.
- **private_key:** Must be a valid key format. Invalid format results in an error; incorrect key (decryption failure) is handled per section 8.2.
- **cursor:** Must conform to expected structure. Malformed cursors result in an error.
- **max_reads:** Must be a positive integer within allowed bounds.
- **Address fields:** Must be valid Starknet addresses.

## 5.5 Privacy Model

Users trust the service operator. The operator can observe:

- Which recipients are active and when.
- How many channels, subchannels, and notes each recipient has.
- Token addresses used per channel.
- Timing of sync activity.

This metadata exposure is accepted given the trust model. Users requiring stronger privacy guarantees should run their own instance.
