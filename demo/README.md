# Privacy Pool Explorer

Developer-facing demo app for interacting with the privacy pool on StarkNet integration sepolia. Replicates the e2e test flow via a GUI — showing balances, notes, channels, and enabling deposits/withdrawals/transfers.

## Prerequisites

- Node.js 20+
- Rust toolchain (for the discovery service)
- SDK built (`cd sdk && npm run build`)

## Setup

```bash
cd demo
cp .env.example .env    # edit if needed
npm install
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `VITE_RPC_URL` | StarkNet RPC endpoint |
| `VITE_INDEXER_URL` | Discovery service API URL |
| `VITE_POOL_ADDRESS` | Privacy pool contract address |
| `VITE_TOKEN_ADDRESS` | ERC-20 token contract address |
| `VITE_FEE_TOKEN_ADDRESS` | Fee token contract address |
| `VITE_CHAIN_ID` | StarkNet chain ID (hex) |
| `VITE_ADMIN_ADDRESS` | Admin/minter account address |
| `VITE_ADMIN_KEY` | Admin account private key |
| `VITE_ACCOUNTS` | JSON array of user accounts (see `.env.example`) |

## Running

Three components need to be running simultaneously. Use separate terminals.

### 1. Discovery service

Build (once):

```bash
cargo build -p discovery-service
```

Run with the provided config:

```bash
cargo run -p discovery-service -- --config demo/discovery-service.toml
```

Or with env vars directly:

```bash
CONTRACT_ADDRESS=0x29a9cf26f2de1dbe16923fd6da791a2158497baeb9cc2fb8f99ed464938d731 \
RPC_URL=http://34.170.239.64:9545/rpc/v0_10 \
WS_URL=ws://34.170.239.64:9545/ws/rpc/v0_8 \
API_HOST=127.0.0.1:8080 \
RUST_LOG=info \
cargo run -p discovery-service
```

Wait for `API server listening` in the logs before proceeding.

### 2. Demo app

```bash
cd demo
npm run dev
```

Open http://localhost:5173.

### 3. Verify

1. Select an account from the dropdown
2. Click **Refresh** — transparent and private balances appear
3. **Mint** tokens → transparent balance increases
4. **Deposit** → private balance increases, note appears in the notes table
5. **Transfer** → new outgoing channel appears
6. **Withdraw** → private balance decreases, transparent increases

## Architecture

- **Vite + React + TypeScript** — single-page app
- **SDK consumption** — `starknet-sdk` linked from `../sdk` (same as e2e)
- **Proof provider** — `NoValidateProofProvider` calls `execute_view` directly (no real proving)
- **Discovery** — `IndexerDiscoveryProvider` talks to the local discovery service
- **Resource bounds** — hardcoded for integration sepolia (2x headroom over actual block prices)
