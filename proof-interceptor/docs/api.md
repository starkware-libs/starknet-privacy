# API reference

Wire-format examples for the JSON-RPC interface, the calldata layout the screening logic depends on, and a runnable HMAC signing snippet for verifying partner credentials end-to-end.

For the high-level flow, see [`screening-flow.md`](screening-flow.md). For the implications of each response shape, see [`security-boundaries.md`](security-boundaries.md).

## HTTP endpoints

| Path | Method | Description |
|---|---|---|
| `/` | POST | JSON-RPC entrypoint. Only `starknet_checkTransaction` is accepted; everything else returns `-32601 Method not found`. |
| `/health` | GET | Liveness/readiness. Returns `200 {"status":"ok"}`. |
| `/metrics` | GET | Prometheus metrics. |

## Request body

What the prover sends. The `params` shape mirrors `starknet_proveTransaction` and accepts either by-name (object) or positional (array `[block_id, transaction]`) form. The calldata below is a **single direct pool call carrying one Deposit action** (the only shape that gets screened), so `SCREENING_POOL_ADDRESS` here is `0xabc...1234` and the depositor address (`user_addr`, `inner_calldata[0]`) is what gets sent to elliptic-proxy:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "starknet_checkTransaction",
  "params": {
    "block_id": "latest",
    "transaction": {
      "type": "INVOKE",
      "version": "0x3",
      "sender_address": "0x49d36570d4e46f48e99674bd3fcc8463d4a1d9b6c8e1e6c4e3e3a8b5a4d3c2b1",
      "calldata": [
        "0x1",
        "0xabc0000000000000000000000000000000000000000000000000000000001234",
        "0x12345678",
        "0x6",
        "0x49d36570d4e46f48e99674bd3fcc8463d4a1d9b6c8e1e6c4e3e3a8b5a4d3c2b1",
        "0x73e1d8c4b9a2f6e7d3c5b4a1f8e9d2c6b5a3f1e4d7c8b9a2f3e6d4c7b1a8f5e9",
        "0x1",
        "0x5",
        "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
        "0x16345785d8a0000"
      ],
      "signature": ["0x...", "0x..."],
      "nonce": "0x0",
      "resource_bounds": {
        "l1_gas":  { "max_amount": "0x...", "max_price_per_unit": "0x..." },
        "l2_gas":  { "max_amount": "0x...", "max_price_per_unit": "0x..." }
      },
      "tip": "0x0",
      "paymaster_data": [],
      "account_deployment_data": [],
      "nonce_data_availability_mode": "L1",
      "fee_data_availability_mode": "L1"
    }
  }
}
```

### Calldata layout breakdown

| Index | Value | Meaning |
|---|---|---|
| 0 | `"0x1"` | `call_count` -- must be exactly 1 to be a "single pool call" |
| 1 | `0xabc...1234` | `contract_address` -- must equal `SCREENING_POOL_ADDRESS` |
| 2 | `0x12345678` | entrypoint selector (not inspected by this service) |
| 3 | `"0x6"` | `inner_calldata_len` -- 6 felts of inner calldata follow |
| 4 | `0x49d36...2b1` | `user_addr` -- **the address sent to Elliptic** |
| 5 | `0x73e1...f5e9` | `user_private_key` -- passed through, never inspected |
| 6 | `"0x1"` | action span: 1 action follows |
| 7 | `"0x5"` | action variant id -- `0x5` is **Deposit** (other variants: `0x0` SetViewingKey, `0x7` Withdraw, others). Only Deposit triggers screening. |
| 8 | `0x4718...938d` | Deposit action: token address |
| 9 | `0x16345785d8a0000` | Deposit action: amount |

## Response shapes

### Allow

What the prover receives when screening succeeds and no sanction matches, *and* what bypass cases (multi-call, non-pool, withdraw-only) return:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "allowed": true } }
```

### Block -- sanction match

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": 10000,
    "message": "Transaction rejected",
    "data": "address screening: 0x49d36570d4e46f48e99674bd3fcc8463d4a1d9b6c8e1e6c4e3e3a8b5a4d3c2b1 blocked"
  }
}
```

### Block -- screening unavailable (`SCREENING_FAIL_OPEN=false`)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": 10000,
    "message": "Transaction rejected",
    "data": "screening unavailable for 0x49d36570d4e46f48e99674bd3fcc8463d4a1d9b6c8e1e6c4e3e3a8b5a4d3c2b1"
  }
}
```

### Envelope rejection (a *different* error code)

The prover treats any non-`10000` error as inconclusive, not as a block:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": 61, "message": "Unsupported tx version", "data": "Only version 0x3 is supported, got: 0x1" }
}
```

## Reproducing locally

```bash
curl -fsS http://localhost:8080/ \
  -H 'content-type: application/json' \
  -d @request.json | jq .
```

## HMAC signing snippet

Verify partner credentials authenticate against the elliptic-proxy *before* deploying the sidecar. A 401 here will manifest as `proof_interceptor_screening_results_total{result="unavailable"}` later, much harder to debug from inside a Pod.

Runnable Node.js one-liner (no npm dependencies, requires Node >= 18 for `fetch`):

```bash
SCREENING_URL='https://...' \
SCREENING_PARTNER_NAME='your-partner' \
SCREENING_PARTNER_SECRET='base64-secret' \
ADDR='0xd8da6bf26964af9d7eed9e03e53415d37aa96045' \
node -e '
  import("node:crypto").then(({ createHmac }) => {
    const url = process.env.SCREENING_URL;
    const partner = process.env.SCREENING_PARTNER_NAME;
    const secret = process.env.SCREENING_PARTNER_SECRET;
    const path = "/screen";
    const body = JSON.stringify({ address: process.env.ADDR });
    const ts = Date.now().toString();
    const sig = createHmac("sha256", Buffer.from(secret, "base64"))
      .update(ts).update("POST").update(path).update(body)
      .digest("base64");
    fetch(url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-access-key": partner,
        "x-access-sign": sig,
        "x-access-timestamp": ts,
      },
      body,
    }).then(r => r.text().then(t => console.log(r.status, t)));
  });
'
```

Expected output:

- `200 {"blocked":false,"source":"..."}` for a clean address.
- `200 {"blocked":true,...}` for a sanctioned address.
- `401` indicates a credential mismatch -- the partner secret is base64; do not re-encode it.

The HMAC scheme matches `src/screening-interceptor.ts:computeHmacSignature`, so if this snippet works the sidecar will too:

- HMAC-SHA256 over `timestamp || method || path.toLowerCase() || body`.
- Key is the **base64-decoded** partner secret.
- Signature is base64-encoded.
- Headers carry `x-access-key`, `x-access-sign`, `x-access-timestamp`.
