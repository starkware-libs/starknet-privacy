## Spinning up the deferred-apply demo

Use this rule when the user asks to "run/start/spin up the demo", "show me the
demo locally", "open localhost:5173", or anything similar in this repo.

### Prerequisites

- Node ≥ 20 (the demo uses Vite 6).
- The SDK must be built once. The demo imports it via `file:../sdk`, so a
  stale `sdk/dist/` will produce confusing missing-export errors at runtime.

### One-shot command

```bash
cd sdk && npm install && npm run build && cd ../demo && npm install && npm run dev
```

Vite serves at `http://localhost:5173/` in `--mode testnet`. The tracked
`demo/.env.testnet` is loaded automatically — it already points at the
deferred-apply pool on Sepolia (`VITE_POOL_ADDRESS`,
`VITE_POOL_CLASS_HASH`), the shared indexer / prover / RPC, the explorer
URL, and the Ekubo / Vesu mock helpers.

### Running it from an agent

- Always start `npm run dev` with `run_in_background: true` and wait for the
  literal `Local:   http://localhost:5173/` line in the log before
  reporting it's ready. Vite prints it within ~200 ms in dev.
- Watch for an early failure too — `EADDRINUSE`, `Missing "./dist/..."
  specifier`, or `ENOENT` on the sdk directory all surface before the
  ready line.
- After config edits, Vite hot-reloads `src/`. Changes to `vite.config.ts`
  or any `.env*` file trigger a server restart; the user must hard-refresh
  the browser tab (the page itself doesn't auto-reload on restart).
- Don't kill the dev server unless asked — the user will usually keep it
  running across multiple turns.

### What the user has to do

The demo has no preconfigured accounts. After it boots, the user has to
click **Import** in the AccountSelector and paste a JSON array:

```json
[{"name":"Me","address":"0x...","privateKey":"0x..."}]
```

The address needs a Sepolia balance (STRK for fees, plus whatever they
plan to deposit).

### Deferred-apply UX

- The **Deferred apply** checkbox sits in the right-hand Config panel.
- When on, every action in the Actions tab (Register / Deposit / Withdraw /
  Transfer) and in the Builder tab runs `store_actions` only. The Pending
  stored actions panel above the Config island shows each pending entry
  with an **Apply** button that triggers `apply_stored_actions(hash)`.
- Pending entries are persisted in `localStorage["pendingStoredActions"]`
  per-account, so a page reload doesn't lose them.
- Paymaster is **bypassed** in deferred mode — its checkbox is auto-disabled
  with a `bypassed` chip when deferred is on.

### Personal overrides

Anything in `demo/.env.testnet.local` (gitignored) wins over the tracked
`.env.testnet`. Typical overrides:

- `VITE_POOL_ADDRESS` + `VITE_POOL_CLASS_HASH` to target a different pool.
- `VITE_RPC_URL` to use a different Sepolia RPC.
- `VITE_PAYMASTER_URL` + `VITE_PAYMASTER_FEE_TOKEN` + `VITE_AVNU_API_KEY`
  to enable the AVNU paymaster checkbox in the Config island.

### Common gotchas

- "Requested entrypoint does not exist": the user is hitting an entrypoint
  that doesn't exist on the configured `VITE_POOL_ADDRESS`. Either the
  pool address points at the *original* pool (no `store_actions`) while
  deferred is toggled on, or the demo's `proof-provider.ts` is calling
  the wrong selector. Confirm `getClassHashAt(VITE_POOL_ADDRESS)` matches
  `VITE_POOL_CLASS_HASH` and that the contract exposes the selector being
  called (use `node -e "import('starknet').then(s => console.log(s.hash.getSelectorFromName('foo')))"`
  to compute selectors).
- "Missing specifier" for `starknet-sdk/dist/internal/...`: the SDK's
  package.json `exports` field doesn't allow deep imports, so vite needs
  an explicit alias in `demo/vite.config.ts`. Existing aliases cover
  `mock-proving.js`, `indexer-discovery.js`, and `proof-invocation-factory.js`.
- `/api/rpc` 404s locally: that path is the Vercel proxy. For `npm run
  dev`, `VITE_RPC_URL` must be a direct URL (it is, in the tracked
  `.env.testnet`).
- After editing `.env.testnet.local`, Vite restarts but the browser tab
  shows stale env until a hard-refresh.

### Do not

- Don't propose redeploying the pool to fix a demo issue — that's a
  separate operation. Update the env first; only re-deploy if the contract
  itself changed.
- Don't `vercel pull` or `vercel deploy` to debug local issues. Use
  `.env.testnet` / `.env.testnet.local` and `npm run dev`.
