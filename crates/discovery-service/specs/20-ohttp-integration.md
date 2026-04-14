# 20. Oblivious HTTP (OHTTP) Integration

## 20.1 Purpose

OHTTP (RFC 9458) provides application-layer encryption of HTTP requests and responses, independent of TLS. This serves two deployment modes:

1. **With a privacy relay** (e.g. Cloudflare Privacy Gateway): separates knowledge of _who_ is making a request from _what_ the request contains. The relay sees the client IP but cannot read the encrypted request; the discovery service sees the decrypted request but not the client IP. This eliminates IP-level metadata correlation.

2. **Without a relay** (direct client-to-service): decouples sensitive data encryption from TLS. Viewing keys and decrypted note data are protected by HPKE encryption at the application layer, so TLS can be terminated at a load balancer or CDN edge without exposing request content to the terminating infrastructure. This allows late TLS termination without sacrificing confidentiality of the payload.

   **Trust caveat:** the client fetches the server's OHTTP public key via `GET /ohttp-keys`. Any entity that can intercept this request (e.g., a TLS-terminating proxy) can substitute the key and decrypt subsequent requests. In the relay-less mode, the client MUST either fetch the key config over a TLS connection terminated at a trusted entity, or pin the `publicKeyConfig` out-of-band. Without one of these, the payload encryption guarantee does not hold.

## 20.2 Network Topology

**With relay (full privacy):**
```
SDK (Client) ──── Privacy Relay ──── Discovery Service
                  (e.g. Cloudflare     (Gateway + Target)
                   Privacy Gateway)
```

**Without relay (payload encryption only):**
```
SDK (Client) ──── [TLS termination] ──── Discovery Service
                  (CDN / load balancer)    (Gateway + Target)
```

The intended production deployment uses a third-party privacy relay such as [Cloudflare Privacy Gateway](https://blog.cloudflare.com/oblivious-http-application-gateway/) between the SDK and the discovery service. The relay forwards `message/ohttp-req` payloads without being able to decrypt them.

In the relay-less mode, the client sends OHTTP-encapsulated requests directly to the service (or through a TLS-terminating proxy). The operator can still correlate requests with client IPs, but the payload is encrypted end-to-end between the client and the gateway — a TLS-terminating proxy in between cannot read viewing keys or decrypted data.

The discovery service acts as both the OHTTP **gateway** (decapsulates requests) and the **target resource** (processes them). This is a single-hop OHTTP deployment — no separate gateway-to-target leg is needed.

## 20.3 Gateway Endpoint

The discovery service exposes two OHTTP-related endpoints:

- `GET /ohttp-keys` — serves the server's HPKE public key configuration (plaintext, cacheable).
- `POST /` — the OHTTP gateway. Accepts `message/ohttp-req` encapsulated requests, decapsulates them, routes internally, and returns `message/ohttp-res`.

Per RFC 9458, the relay is configured with the service's base URL and forwards all encapsulated requests to `POST /`. The **target API path** (e.g., `/v1/sync/incoming_state`) is inside the encrypted Binary HTTP payload — invisible to the relay. After decapsulation, the gateway extracts the inner path and routes through the API router.

Plaintext `application/json` requests to specific API paths (e.g., `POST /v1/sync/incoming_state`) continue to work unchanged — this supports direct client-to-service access without a relay.

## 20.4 Request Flow

1. Client fetches `GET /ohttp-keys` to obtain the server's HPKE public key configuration.
2. Client constructs a Binary HTTP request (RFC 9292) containing the JSON API call.
3. Client encapsulates the Binary HTTP request using the server's key config → produces an OHTTP-encrypted blob.
4. Client sends the blob as `POST /` with `Content-Type: message/ohttp-req` to the relay's configured gateway URL.
5. The relay forwards the opaque blob to `POST /` on the discovery service.
6. The `OhttpLayer` middleware (from the `tower_ohttp` crate) processes the request:
   a. Buffers the encrypted body (enforcing `max_request_body_bytes` limit).
   b. Decapsulates the HPKE envelope using the server's private key.
   c. Parses the inner Binary HTTP message.
   d. Rebuilds a standard `http::Request` preserving method, path, headers, and body from the BHTTP payload.
   e. Routes through the API router (handler is unaware of OHTTP).
7. The handler produces a response as usual.
8. The middleware encodes the response as Binary HTTP (preserving status code and headers), encrypts it with the OHTTP response context, and returns `Content-Type: message/ohttp-res`.
9. The relay forwards the encrypted response to the client.
10. Client decapsulates to obtain the plaintext JSON response.

## 20.5 Key Configuration

| Parameter | Value |
|-----------|-------|
| KEM | X25519 + HKDF-SHA256 (`Kem::X25519Sha256`) |
| KDF | HKDF-SHA256 |
| AEAD | AES-128-GCM |
| Key ID | 0 (single key per instance) |
| Key source | `OHTTP_KEY` env var (hex-encoded 32-byte X25519 private key) |
| Key config endpoint | `GET /ohttp-keys` (`application/ohttp-keys`, `Cache-Control: public, max-age=<key_cache_max_age_secs>`) |

The server derives the full HPKE key pair from the IKM seed. The public key is encoded in the RFC 9458 key configuration format and served at `/ohttp-keys`.

Key rotation requires restarting the service with a new `OHTTP_KEY` value. The server sets `Cache-Control: public, max-age=<key_cache_max_age_secs>` on the `/ohttp-keys` response (default 3600s). Clients SHOULD respect this header to determine when to re-fetch. During rotation, clients holding the old config will receive decapsulation failures and must re-fetch.

**Note:** the current SDK implementation does not read `Cache-Control` and uses a hardcoded 1-hour TTL. Until this is addressed, changing `key_cache_max_age_secs` below 3600 will not accelerate key rotation for SDK clients.

## 20.6 Body Size Limit

The `OhttpLayer` enforces the same `max_request_body_bytes` limit on all incoming request bodies (both OHTTP and plaintext). Oversized requests receive a plaintext `413 Payload Too Large` response with error code `OHTTP_BODY_TOO_LARGE` — this error cannot be encrypted since decapsulation has not yet occurred.

## 20.7 Configuration

OHTTP is opt-in. All settings live under `[ohttp]` in TOML config:

| Setting | Env var | TOML key | Default | Description |
|---------|---------|----------|---------|-------------|
| Enable | `OHTTP_ENABLED` | `ohttp.enabled` | `false` | Enable OHTTP gateway and `/ohttp-keys` endpoints |
| Key | `OHTTP_KEY` | — | — | Hex-encoded 32-byte X25519 private key (required when enabled) |
| Key cache max-age | — | `ohttp.key_cache_max_age_secs` | `3600` | `Cache-Control` max-age (seconds) for the `/ohttp-keys` response |

When disabled, no OHTTP middleware is installed. When enabled but `OHTTP_KEY` is missing or invalid, the service exits on startup.

## 20.8 Transparent Gateway

The OHTTP gateway is implemented as a tower middleware layer (`OhttpLayer` from the `tower_ohttp` crate) installed as a fallback service on the Axum router. Unmatched requests (including `POST /` from a relay) hit the fallback, where the layer decapsulates the OHTTP envelope and re-routes the inner request through a cloned API router. Matched plaintext requests bypass OHTTP entirely. Handlers receive normal requests and return normal responses with no knowledge of OHTTP.

The gateway preserves the inner request's HTTP method, path, and all BHTTP headers. All API endpoints — both `POST` (`/v1/sync/incoming_state`, `/v1/sync/outgoing_state`, `/v1/sync/preflight_check`, `/v1/history`) and `GET` (`/health`) — are reachable through OHTTP.

## 20.9 Privacy Properties

| Property | Without OHTTP | OHTTP without relay | OHTTP with relay |
|----------|---------------|---------------------|-------------------|
| Client IP visible to operator | Yes | Yes | No — relay terminates the connection |
| Request content visible to operator | Yes | Yes | Yes — operator decrypts the OHTTP envelope |
| Request content visible to TLS proxy | Yes | No — HPKE encrypted | No — HPKE encrypted |
| Request content visible to relay | N/A | N/A | No — relay cannot decrypt |
| Target API path visible to relay | N/A | N/A | No — encrypted inside Binary HTTP |
| Timing correlation | Possible | Possible | Reduced but not eliminated |

OHTTP does **not** protect against:
- Traffic analysis (request sizes, timing patterns) by a relay-operator collusion.
- Content-level metadata the operator already observes (viewing keys, channel counts, token addresses).
- Timing correlation by a passive network observer who can see both client→relay and relay→service traffic.

For stronger guarantees, users should run their own discovery service instance.
