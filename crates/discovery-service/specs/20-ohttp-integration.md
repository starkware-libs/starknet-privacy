# 20. Oblivious HTTP (OHTTP) Integration

## 20.1 Purpose

OHTTP (RFC 9458) provides application-layer encryption of HTTP requests and responses, independent of TLS. This serves two deployment modes:

1. **With a privacy relay** (e.g. Cloudflare Privacy Gateway): separates knowledge of _who_ is making a request from _what_ the request contains. The relay sees the client IP but cannot read the encrypted request; the discovery service sees the decrypted request but not the client IP. This eliminates IP-level metadata correlation.

2. **Without a relay** (direct client-to-service): decouples sensitive data encryption from TLS. Viewing keys and decrypted note data are protected by HPKE encryption at the application layer, so TLS can be terminated at a load balancer or CDN edge without exposing request content to the terminating infrastructure. This allows late TLS termination without sacrificing confidentiality of the payload.

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
6. The `ohttp_gateway_handler` processes the request:
   a. Reads the encrypted body (enforcing `max_request_body_bytes` limit).
   b. Decapsulates the HPKE envelope using the server's private key.
   c. Parses the inner Binary HTTP message.
   d. Rebuilds a standard `http::Request` with the inner JSON body and path.
   e. Forwards to the handler (handler is unaware of OHTTP).
7. The handler produces a JSON response as usual.
8. The gateway handler encodes the response as Binary HTTP, encrypts it with the OHTTP response context, and returns `Content-Type: message/ohttp-res`.
9. The relay forwards the encrypted response to the client.
10. Client decapsulates to obtain the plaintext JSON response.

## 20.5 Key Configuration

| Parameter | Value |
|-----------|-------|
| KEM | P-256 + HKDF-SHA256 (`Kem::P256Sha256`) |
| KDF | HKDF-SHA256 |
| AEAD | AES-128-GCM |
| Key ID | 0 (single key per instance) |
| Key source | `OHTTP_KEY` env var (hex-encoded 32-byte P-256 IKM seed) |
| Key config endpoint | `GET /ohttp-keys` (`application/ohttp-keys`, `Cache-Control: public, max-age=<key_cache_max_age_secs>`) |

The server derives the full HPKE key pair from the IKM seed. The public key is encoded in the RFC 9458 key configuration format and served at `/ohttp-keys`.

Key rotation requires restarting the service with a new `OHTTP_KEY` value. Clients cache the key config for the duration specified by `key_cache_max_age_secs` (default 3600s / 1 hour). During rotation, clients holding the old config will receive decapsulation failures and must re-fetch.

## 20.6 Body Size Limit

The OHTTP layer enforces the same `max_request_body_bytes` limit as plaintext requests. The encrypted body is wrapped in `http_body_util::Limited` before collection. Oversized requests receive a plaintext `413 Payload Too Large` response with error code `OHTTP_BODY_TOO_LARGE` — this error cannot be encrypted since decapsulation has not yet occurred.

## 20.7 Enabling OHTTP

OHTTP is opt-in via configuration:

- `OHTTP_ENABLED=true` (or `"1"`) — enables the OHTTP layer.
- `OHTTP_KEY` — required when enabled; hex-encoded 32-byte IKM seed.

When disabled, no OHTTP routes or middleware are registered. When enabled but `OHTTP_KEY` is missing or invalid, the service exits on startup.

## 20.8 Transparent Gateway

The OHTTP gateway is a single Axum handler (`ohttp_gateway_handler`) at `POST /`. After decapsulating the request, it rebuilds a standard `http::Request` and routes it through the API router — handlers receive normal requests and return normal responses with no knowledge of OHTTP. This means:

- No handler code changes are required to support OHTTP.
- All existing API endpoints work through OHTTP without modification.
- The same handler serves both OHTTP (via `POST /`) and plaintext clients (via direct API paths).

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
