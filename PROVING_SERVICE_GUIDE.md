# Proving Service integration

The SDK can use a **remote Proving Service** instead of the local mock (execute_view) to generate proofs.

## How to test the integration

### 1. Health check (no devnet, no account)

Verifies the proving service is reachable and returns a spec version:

```bash
cd sdk
npx tsx scripts/check-proving-service.ts
# Or with a custom URL:
npx tsx scripts/check-proving-service.ts http://136.115.124.93:3000
```

You should see: `OK – starknet_specVersion: 0.10.0` (or similar).

### 2. Devnet test with the proving service

Runs the full devnet flow (deploy contracts, register, deposit, transfer) using the **remote prover** instead of the local `execute_view` mock:

```bash
cd sdk
PROVING_SERVICE_URL=http://136.115.124.93:3000 npm run test -- devnet.test.ts
```

**Note:** This only works if the proving service is configured to prove against the **same chain state** as the local devnet (e.g. the prover’s RPC points at your devnet). If the prover is tied to a different network (e.g. Sepolia), `starknet_proveTransaction` may fail (e.g. block/contract not found). In that case, test on the network the prover supports, with a deployed pool and real account.

### 3. Integration on a live network

Use `createPrivateTransfers` with `ProvingServiceProofProvider` against a deployed pool on the network your prover supports (e.g. Sepolia). Run your app or a small script that performs one action (e.g. register or deposit) and calls `execute()`; that will call the proving service under the hood.

## Default endpoint

- **Base URL:** `http://136.115.124.93:3000`
- **Health check:** `POST` with `{ "jsonrpc": "2.0", "id": 1, "method": "starknet_specVersion", "params": [] }`

## Using the Proving Service with the SDK

### 1. With `createPrivateTransfers` (production or custom flows)

```ts
import {
  createPrivateTransfers,
  ProvingServiceProofProvider,
  ContractDiscoveryProvider,
} from "starknet-sdk";
import { constants } from "starknet";

const privateTransfers = createPrivateTransfers({
  account: myAccount,
  viewingKeyProvider: { getViewingKey: () => myViewingKey },
  provingProvider: new ProvingServiceProofProvider({
    baseUrl: "http://136.115.124.93:3000",
    chainId: constants.StarknetChainId.SN_SEPOLIA,
    blockId: "latest",
    timeoutMs: 120_000,
  }),
  discoveryProvider: new ContractDiscoveryProvider(poolContract, {}),
  poolContractAddress: poolContract.address,
});
```

### 2. With devnet test env

Use `provingServiceUrl` in the config to point tests at the proving service instead of the call-based mock:

```ts
import { Devnet, createDevnetTestEnv } from "starknet-sdk/testing";

const devnet = new Devnet();
const { transfers } = await createDevnetTestEnv(devnet, {
  provingServiceUrl: "http://136.115.124.93:3000",
  provingServiceTimeoutMs: 120_000,
});
// transfers.alice and transfers.bob now use the remote prover
```

## API summary (JSON-RPC)

- **starknet_specVersion** – health check, returns spec version (e.g. `"0.10.0"`).
- **starknet_proveTransaction** – `(block_id, transaction)` → `{ proof, proof_facts, l2_to_l1_messages }`.  
  Only **Invoke V3** transactions are supported.

See the *Proving Service SDK Developer Guide* (docx) for full types, error codes, and examples.
