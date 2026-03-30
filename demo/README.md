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
| `VITE_TOKEN_ADDRESS` | ERC-20 token contract address |
| `VITE_FEE_TOKEN_ADDRESS` | Fee token contract address |
| `VITE_CHAIN_ID` | StarkNet chain ID (hex) |
| `VITE_ADMIN_ADDRESS` | Admin/minter account address |
| `VITE_ADMIN_KEY` | Admin account private key |

## Running

```bash
cd demo
npm run dev
```

Open http://localhost:5173.

### Verify

1. Click **Import** and paste a JSON array of accounts: `[{"name":"Alice","address":"0x...","privateKey":"0x...","viewingKey":"0x..."}]`
2. Select an account tab
3. Click **Refresh** — transparent and private balances appear
4. **Mint** tokens → transparent balance increases
5. **Deposit** → private balance increases, note appears in the notes table
6. **Transfer** → new outgoing channel appears
7. **Withdraw** → private balance decreases, transparent increases

## Architecture

- **Vite + React + TypeScript** — single-page app
- **SDK consumption** — `starknet-sdk` linked from `../sdk` (same as e2e)
- **Proof provider** — With `VITE_PROVING_SERVICE_URL` set, uses the real proving service; otherwise `NoValidateProofProvider` calls `execute_view` directly (mock, no real proof)
- **Discovery** — `IndexerDiscoveryProvider` talks to the remote discovery service
- **Resource bounds** — hardcoded for integration sepolia (2x headroom over actual block prices)
