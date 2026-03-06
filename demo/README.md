# Privacy Pool Explorer

Developer-facing demo app for interacting with the privacy pool on StarkNet integration sepolia. Replicates the e2e test flow via a GUI — showing balances, notes, channels, and enabling deposits/withdrawals/transfers.

## Prerequisites

- Node.js 20+

## Setup

```bash
# Build the SDK (demo links to it via file:../sdk)
cd sdk && npm install && npm run build && cd ..

cd demo
cp .env.example .env    # edit with real addresses and keys
npm install
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `VITE_RPC_URL` | StarkNet RPC endpoint |
| `VITE_INDEXER_URL` | Discovery service API URL |
| `VITE_PROVING_SERVICE_URL` | Proving service URL. If unset, the app uses the mock prover (`execute_view` only) |
| `VITE_POOL_ADDRESS` | Privacy pool contract address |
| `VITE_FEE_TOKEN_ADDRESS` | Fee token contract address |
| `VITE_CHAIN_ID` | StarkNet chain ID (hex) |
| `VITE_POOL_CLASS_HASH` | Privacy pool class hash |
| `VITE_COMPLIANCE_PUBLIC_KEY` | Compliance public key for the pool |
| `VITE_PROOF_VALIDITY_BLOCKS` | Number of blocks a proof remains valid |
| `VITE_ADMIN_ADDRESS` | Admin/minter account address |
| `VITE_ADMIN_KEY` | Admin account private key |
| `VITE_TOKENS` | JSON array of supported tokens (see `.env.example`) |
| `VITE_ACCOUNTS` | JSON array of user accounts (see `.env.example`) |

**Ekubo swap (optional — all required if `VITE_EXECUTOR_ADDRESS` is set):**

| Variable | Description |
|----------|-------------|
| `VITE_EXECUTOR_ADDRESS` | Ekubo swap executor contract address |
| `VITE_EKUBO_CORE_ADDRESS` | Ekubo core contract address |
| `VITE_EKUBO_SWAP_TOKENS` | JSON array of tokens available for swap |
| `VITE_EKUBO_POOL_FEE` | Ekubo pool fee (u128) |
| `VITE_EKUBO_TICK_SPACING` | Ekubo pool tick spacing |
| `VITE_EKUBO_EXTENSION` | Ekubo pool extension address |
| `VITE_EKUBO_SKIP_AHEAD` | Ekubo pool skip ahead value |

## Running

```bash
cd demo
npm run dev
```

Open http://localhost:5173.

### Verify

1. Select an account from the dropdown
2. Click **Refresh** — transparent and private balances appear
3. **Mint** tokens → transparent balance increases
4. **Deposit** → private balance increases, note appears in the notes table
5. **Transfer** → new outgoing channel appears
6. **Withdraw** → private balance decreases, transparent increases

## Vercel deployment

The demo deploys to Vercel as a preview on PRs that touch `demo/`. The Vercel project is already linked (`demo/.vercel/`).

**How it works:**

- The `demo-deploy.yml` workflow runs `vercel pull` + `vercel build` + deploys on PRs touching `demo/`.
- `VITE_*` vars use `/api/*` proxy paths (not direct HTTP URLs) to avoid mixed HTTP/HTTPS content errors on the HTTPS Vercel deployment.
- `BACKEND_*` vars (`BACKEND_RPC_URL`, `BACKEND_INDEXER_URL`, `BACKEND_PROVER_URL`, `BACKEND_GATEWAY_URL`) define the actual backend endpoints. CI reads them and generates `vercel.json` rewrite rules that proxy `/api/*` requests to the real backends.

**Setting env vars:**

A helper script `scripts/set-vercel-env.sh` uploads vars from a `.env` file to any Vercel environment. It only adds — never removes or overwrites existing vars.

```bash
# Usage: bash scripts/set-vercel-env.sh <env-file> <vercel-environment>
cd demo
bash scripts/set-vercel-env.sh .env production
bash scripts/set-vercel-env.sh .env preview
bash scripts/set-vercel-env.sh .env ekubo-demo   # custom environment
```

Verify the vars were set correctly:

```bash
npx vercel env pull .env.verify --environment=<environment>
```

## Architecture

- **Vite + React + TypeScript** — single-page app
- **SDK consumption** — `starknet-sdk` linked from `../sdk` (same as e2e)
- **Proof provider** — With `VITE_PROVING_SERVICE_URL` set, uses the real proving service; otherwise `NoValidateProofProvider` calls `execute_view` directly (mock, no real proof)
- **Discovery** — `IndexerDiscoveryProvider` talks to the remote discovery service
- **Resource bounds** — hardcoded for integration sepolia (2x headroom over actual block prices)
