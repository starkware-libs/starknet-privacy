# Demo deployment guide

The `demo/` app is a Vite SPA (no backend). This doc covers what to put in
Vercel env and the invariants that protect users against key exfiltration
when the demo is hosted publicly.

## Env file layout

Local dev uses mode-scoped files so testnet and mainnet configs are strictly
isolated:

- `.env.testnet.local` — loaded by `npm run dev` / `npm run build:testnet`
- `.env.mainnet.local` — loaded by `npm run dev:mainnet` / `npm run build:mainnet`
- `.env` / `.env.local` — load in **every** mode; keep empty or absent

Vercel deployments use the default production mode: `npm run build` reads
`.env.production.local`, which is populated by `vercel pull` from the env
configured in the Vercel dashboard (see the required-vars table below).

## Hard rules

1. **No `VITE_*` variable may ever contain a signing key.** Every `VITE_*`
   value is embedded verbatim into the public JS bundle — anyone loading
   the page downloads them. Only public addresses, class hashes, chain ids,
   RPC URLs, and the OHTTP key config belong there.
2. **On mainnet (`VITE_CHAIN_ID=0x534e5f4d41494e`), pasted signing keys live
   in tab memory only.** The JSON import flow does not write to
   `localStorage`, the `?accounts=` share URL has been removed, and OHTTP
   is enforced (the toggle is disabled). Reload clears state.
3. **Rotate immediately if a signing key ever slipped into a `VITE_*` var.**
   Treat it as fully compromised: assume every past visitor captured it.
   Remove from Vercel env, redeploy, and move funds to a fresh account.

## Required Vercel env (mainnet preview)

| Name                         | Purpose                                                |
| ---------------------------- | ------------------------------------------------------ |
| `VITE_RPC_URL`               | StarkNet mainnet RPC                                   |
| `VITE_INDEXER_URL`           | Discovery service URL                                  |
| `VITE_PROVING_SERVICE_URL`   | Proving service URL                                    |
| `VITE_POOL_ADDRESS`          | Privacy pool contract address (mainnet)                |
| `VITE_POOL_CLASS_HASH`       | Pool class hash                                        |
| `VITE_COMPLIANCE_PUBLIC_KEY` | Compliance pubkey                                      |
| `VITE_CHAIN_ID`              | `0x534e5f4d41494e`                                     |
| `VITE_TOKENS`                | JSON array of tokens                                   |
| `VITE_OHTTP_KEY_CONFIG`      | Base64 OHTTP key config (pin it — avoid runtime fetch) |

Also set (not baked into the client bundle — consumed by the deploy workflow):

| Name                  | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `BACKEND_RPC_URL`     | Real RPC endpoint (http) — proxied via `/api/rpc/` |
| `BACKEND_INDEXER_URL` | Real indexer — proxied via `/api/indexer/`         |
| `BACKEND_PROVER_URL`  | Real prover — proxied via `/api/prover/`           |
| `BACKEND_GATEWAY_URL` | Real feeder gateway — proxied via `/api/gateway/`  |

Everything else listed in `.env.mainnet.example` is optional.

## Pre-deploy checklist

```
# 1. List all env vars and look for anything that matches a signing key
vercel env ls preview
vercel env ls production

# 2. Pull them and grep for hex strings longer than 60 chars that aren't
#    known public addresses / class hashes
vercel env pull .vercel/audit.env --environment=preview
grep -Eo '0x[0-9a-fA-F]{60,}' .vercel/audit.env | sort -u
# → visually verify each hit is either VITE_POOL_ADDRESS, VITE_POOL_CLASS_HASH,
#   VITE_COMPLIANCE_PUBLIC_KEY, or a token address. Anything else → rotate.
rm .vercel/audit.env

# 3. Build locally against the production env and check the bundle
cd demo && npx vercel pull --environment=production && npx vercel build --prod
grep -rEo '0x[0-9a-fA-F]{60,}' .vercel/output/static/assets/*.js | sort -u
# → same check
```

## Security headers

The GitHub Actions deploy workflow generates `vercel.json` with:

- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; …` —
  no remote scripts, no `unsafe-eval`, no inline scripts. Blocks framing
  and forbids any third-party script from ever executing.
- `Referrer-Policy: no-referrer`: blocks the `Referer` header so upstream
  services never see the originating URL, page title, or query string.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a
  `Permissions-Policy` denying camera / microphone / geolocation.

If you add a new upstream (e.g. a CDN for fonts), widen `connect-src` /
`script-src` explicitly — don't loosen the whole policy.

## Smoke test after deploy

1. `curl -I https://<preview>.vercel.app/` → verify the headers above are
   present.
2. In the browser, open `view-source:https://<preview>.vercel.app/assets/*.js`
   and grep for `0x[0-9a-f]{60,}` — hits should be public addresses only.
3. Import a **throwaway** account with a tiny balance; do a test deposit /
   withdraw. Reload the page — confirm the account is cleared (not
   persisted to localStorage).
4. In a separate tab, test view-only mode: paste JSON with only
   `{name, address, viewingKey}` (no `privateKey`). Balance and history
   should render, but all action buttons must be disabled with the
   "view-only" tooltip.

## Rotation

If a signing key leaked via any `VITE_*` var:

1. Treat the key as fully public — move any remaining funds immediately.
2. Remove the offending var: `vercel env rm VITE_THE_BAD_VAR preview`.
3. Redeploy the preview so the clean bundle replaces the compromised one.
4. Purge the Vercel deployment's cache if using edge caching.
5. Check the git history — if the value was ever committed, also rotate.
