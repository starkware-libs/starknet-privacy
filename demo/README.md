# Privacy Pool Explorer

Developer-facing demo app for interacting with the privacy pool on StarkNet integration sepolia. Replicates the e2e test flow via a GUI — showing balances, notes, channels, and enabling deposits/withdrawals/transfers.

## Prerequisites

- Node.js 20+

## Setup

For the **deferred-apply** demo on Sepolia, no env editing is needed —
`demo/.env.testnet` is committed with the pool, RPC, indexer, prover, and
explorer URLs already filled in:

```bash
# Build the SDK once (demo links to it via file:../sdk)
cd sdk && npm install && npm run build && cd ..

cd demo
npm install
npm run dev          # http://localhost:5173 — uses .env.testnet
```

Then click **Import** in the UI and paste a JSON array of accounts:

```json
[{"name":"Me","address":"0x...","privateKey":"0x..."}]
```

You're done — Mint / Deposit / Transfer / Withdraw work against the
deferred-apply pool on Sepolia.

### Customising the config

Anything in `.env.testnet.local` (gitignored) overrides `.env.testnet`.
Typical reasons to add it:

- Point at a different pool: set `VITE_POOL_ADDRESS` + `VITE_POOL_CLASS_HASH`.
- Use a different RPC: set `VITE_RPC_URL`.
- Enable the AVNU paymaster: set `VITE_PAYMASTER_URL`, `VITE_PAYMASTER_FEE_TOKEN`, `VITE_AVNU_API_KEY`.

For mainnet, mode is `mainnet` and the corresponding files are
`.env.mainnet` / `.env.mainnet.local` — see `.env.mainnet.example`.

### Env file layout (strict mode isolation)

Vite env files are loaded per mode. To prevent testnet values from silently
leaking into a mainnet run, configs are mode-scoped and `.env` / `.env.local`
are **not** used for chain-specific values:

| File | Loaded when | Use for |
|------|-------------|---------|
| `.env.testnet` | `dev`, `build:testnet` | Tracked baseline — works out of the box |
| `.env.testnet.local` | `dev`, `build:testnet` | Your personal overrides (gitignored) |
| `.env.mainnet.local` | `dev:mainnet`, `build:mainnet`, `preview:mainnet` | Your local mainnet config |
| `.env.example` | never | Reference schema (tracked in git) |
| `.env.mainnet.example` | never | Mainnet reference schema (tracked in git) |

Keep `.env` and `.env.local` empty (or absent). They load in **every** mode —
anything in them leaks between testnet and mainnet.

### Pull environment from Vercel

If you have access to the Vercel project, pull the preview environment directly:

```bash
cd demo
npx tsx ../e2e/scripts/pull-env.ts
```

This creates `.env` with all required variables, rewriting backend URLs for local use.

### Environment variables

| Variable | Description |
|----------|-------------|
| `VITE_RPC_URL` | StarkNet RPC endpoint |
| `VITE_INDEXER_URL` | Discovery service API URL |
| `VITE_PROVING_SERVICE_URL` | Proving service URL. If unset, the app uses the mock prover (`execute_view` only) |
| `VITE_POOL_ADDRESS` | Privacy pool contract address |
| `VITE_CHAIN_ID` | StarkNet chain ID (hex) |
| `VITE_POOL_CLASS_HASH` | Privacy pool class hash |
| `VITE_COMPLIANCE_PUBLIC_KEY` | Compliance public key for the pool |
| `VITE_PROOF_VALIDITY_BLOCKS` | Number of blocks a proof remains valid |
| `VITE_TOKENS` | JSON array of supported tokens. Set `"fee":true` for the gas token, `"mintEntrypoint"` if different from `"permissionedMint"` |

**Ekubo swap (optional — all required if `VITE_EKUBO_EXECUTOR_ADDRESS` is set):**

| Variable | Description |
|----------|-------------|
| `VITE_EKUBO_EXECUTOR_ADDRESS` | Swap executor contract address |
| `VITE_EKUBO_CORE_ADDRESS` | Ekubo Core contract address (for pool price queries) |
| `VITE_EKUBO_ROUTER_ADDRESS` | Ekubo Router contract address (passed to executor) |
| `VITE_EKUBO_POOLS` | JSON array of pool configs (`token0`, `token1`, `fee`, `tickSpacing`, `extension`, `skipAhead`). One entry per supported pair — the anonymizer is single-hop. Token addresses must match entries in `VITE_TOKENS` and be ordered numerically ascending |

**Vesu lending (optional — all required if `VITE_VESU_LENDING_HELPER_ADDRESS` is set):**

| Variable | Description |
|----------|-------------|
| `VITE_VESU_LENDING_HELPER_ADDRESS` | Vesu lending anonymizer contract address |
| `VITE_VESU` | Vaults as JSON. Token names must match entries in `VITE_TOKENS` |

## Running

```bash
cd demo
npm run dev           # testnet (reads .env.testnet.local)
npm run dev:mainnet   # mainnet (reads .env.mainnet.local, enables wallet-only mode)
```

Open http://localhost:5173.

### Verify (testnet)

1. Click **Import** and paste a JSON array of accounts:
   `[{"name":"Alice","address":"0x...","privateKey":"0x..."}]`. If you omit
   `viewingKey`, the demo derives it deterministically by signing a
   canonical `<chainId>:<poolAddress>` message with the private key and
   Poseidon-hashing the `(r, s)` pair. Pass `"viewingKey":"0x..."` alone
   (no `privateKey`) to get a view-only entry.
2. Select an account tab
3. Click **Refresh** — transparent and private balances appear
4. **Mint** tokens → transparent balance increases
5. **Deposit** → private balance increases, note appears in the notes table
6. **Transfer** → new outgoing channel appears
7. **Withdraw** → private balance decreases, transparent increases

### Verify (mainnet)

`.env.mainnet.local` must set `VITE_CHAIN_ID=0x534e5f4d41494e` to trigger
the mainnet lockdown:

- Accounts live in tab memory only. Nothing is written to `localStorage`;
  reload clears state.
- The `?accounts=` share URL has been removed (no build-a-share-link UI).
- OHTTP is forced on — the toggle is present but disabled.
- The transparent mint flow is hidden (no admin account in this profile).

1. Paste a **throwaway** JSON account (use only a test key with a tiny
   balance): `[{"name":"Me","address":"0x...","privateKey":"0x..."}]`.
   `viewingKey` is optional — omit it and the demo derives it from the
   private key (deterministic: sign `<chainId>:<poolAddress>`, hash `(r, s)`
   via Poseidon).
2. Balance, notes, and history render.
3. Try a small **Deposit** / **Transfer** / **Withdraw**. The paste key is
   used for signing only; it never leaves this tab's memory.
4. Reload the page — confirm the account is gone (proof of no-persistence).
5. **View-only**: paste JSON without a `privateKey` field, e.g.
   `[{"name":"Me","address":"0x...","viewingKey":"0x..."}]`. Balance and
   history render; every action button is disabled with a "View-only"
   tooltip.

## Vercel deployment

The demo deploys to Vercel as a preview on PRs that touch `demo/`. The Vercel project is already linked (`demo/.vercel/`).

**How it works:**

- The `demo-deploy.yml` workflow runs `vercel pull` + `vercel build` + deploys on PRs touching `demo/`.
- `VITE_*` vars use `/api/*` proxy paths (not direct HTTP URLs) to avoid mixed HTTP/HTTPS content errors on the HTTPS Vercel deployment.
- `BACKEND_*` vars (`BACKEND_RPC_URL`, `BACKEND_INDEXER_URL`, `BACKEND_PROVER_URL`, `BACKEND_GATEWAY_URL`) define the actual backend endpoints. CI reads them and generates `vercel.json` rewrite rules that proxy `/api/*` requests to the real backends.

## Architecture

- **Vite + React + TypeScript** — single-page app
- **SDK consumption** — `starknet-sdk` linked from `../sdk` (same as e2e)
- **Proof provider** — With `VITE_PROVING_SERVICE_URL` set, uses the real proving service; otherwise `NoValidateProofProvider` calls `execute_view` directly (mock, no real proof)
- **Discovery** — `IndexerDiscoveryProvider` talks to the remote discovery service
- **Resource bounds** — hardcoded for integration sepolia (2x headroom over actual block prices)
