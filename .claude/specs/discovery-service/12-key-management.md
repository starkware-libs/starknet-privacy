# 12. Key Management and Security Posture

## 12.1 Per-Request Keys are the Default

- Keys are supplied with each sync request.
- The service decrypts channels and notes and returns decrypted data.
- Keys are not stored.
- Keys MUST be zeroed from memory after request processing.

This avoids persistent sensitive material in infrastructure.

## 12.2 Persistent Key Storage is an Option, but Not Recommended

Persistent key storage introduces disadvantages:

- **Security risk:** Long-lived secrets become high-value targets.
- **Legal and compliance risk:** Custody of secrets increases obligations.
- **Operational complexity:** Key replication, rotation, and secure storage across replicas.
- **Authentication complexity:** API requests must be strongly authenticated and authorized, and misuse prevention becomes critical.

Given the discovery service can operate with per-request keys, permanent storage is not justified.
