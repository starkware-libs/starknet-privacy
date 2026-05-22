# Privacy SDK

TypeScript SDK for private transfers on Starknet.

## Publishing

To publish a release:

1. Bump `version` in `package.json` to the desired release version
2. Authenticate with GitHub Packages:
   ```sh
   echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc
   ```
3. Build and publish:
   ```sh
   cd sdk
   npm ci
   npm run generate
   npm run build
   npm publish
   ```

## Prerequisites

- **Node.js >= 24** (required by the `ohttp-ts` dependency for WebCrypto APIs)

## Development

```bash
npm run lint      # check formatting (prettier), lints (eslint), and types (tsc)
npm run format    # auto-fix formatting and lint issues
npm run test      # run all tests
npm run test:fast # run tests excluding devnet
```

## Installation

From a tagged release (GitHub npm registry):

```bash
npm install @starkware-libs/starknet-privacy-sdk
```

From a specific commit (git):

```bash
npm install "starkware-libs/starknet-privacy#<commit-sha>"
```

## Quick start

```typescript
import { Account, RpcProvider } from "starknet";
import { createPrivateTransfers, IndexerDiscoveryProvider } from "starknet-sdk";

const provider = new RpcProvider({ nodeUrl: "http://localhost:5050" });
const account = new Account(provider, accountAddress, privateKey);

const transfers = createPrivateTransfers({
  account, // or { address, signer } if you don't have a full Account
  viewingKeyProvider: { getViewingKey: () => viewingKey },
  provingProvider,
  discoveryProvider: new IndexerDiscoveryProvider(discoveryUrl, poolContractAddress),
  poolContractAddress,
});
```

## Typical workflows

This section describes the recommended integration patterns. Each subsection gives one opinionated recipe — stick to it unless you have a specific reason to deviate.

### State management: go stateless

Do not persist `PrivateRegistry` between sessions. Rely on the default full-refresh discovery on every `execute()` call:

```typescript
const result = await transfers
  .build({
    autoDiscover: { notes: "refresh", channels: "refresh" },
    autoSelectNotes: "naive",
  })
  .with(STRK)
  .transfer({ recipient: bob, amount: 50n })
  .surplusTo(self)
  .execute();
```

No local state means no cursor drift, no reorg reconciliation, and no stale-channel bugs.

By default `execute()` mutates the `registry` argument in place. If you want to hand the SDK a registry you intend to reuse elsewhere, pass `registryConst: true` — the call then returns a new registry object and leaves the input untouched. Either way, treat the registry as ephemeral within a session and rebuild it from `discoverNotes` / `discoverChannels` at the start of the next session.

**When to graduate.** Discovery becomes the UX bottleneck only past several thousand notes per account. At that point switch to incremental discovery by storing the `cursor` from the previous `discoverNotes` / `discoverChannels` response and passing it back on the next call (see [Discover notes](#discover-notes)). Incremental adds complexity — don't do it prematurely.

### Speculative balances and history (`pre_confirmed`)

For balance displays, history UI, and other read-only views where latency matters, pass `blockIdentifier: "pre_confirmed"` to `discoverNotes`, `discoverChannels`, and `fetchHistory`:

```typescript
const { notes } = await transfers.discoverNotes({
  blockIdentifier: "pre_confirmed",
});
```

`pre_confirmed` reads the node's speculative next-block state, so newly accepted transactions show up immediately rather than after `ACCEPTED_ON_L2`.

**Precondition — the wallet must already handle reorgs on transparent balances.** If it does, `pre_confirmed` is a free latency win for private state too. If it doesn't, stay on `"latest"` until the wallet's reorg story is solid. Never prove against `pre_confirmed` — the prover requires finalized state (see next subsection).

Caveats:

- Speculative state may be reverted if the pre-confirmed block doesn't finalize.
- Paginated discovery may see the underlying block advance between pages — fine for displaying a balance, not for building a transaction (use a block hash for that).
- Pre-confirmed data can point at a branch that never gets finalized.

**Alternative for a just-submitted tx: optimistic registry.** Every `execute()` returns a registry reflecting the compiled actions (the same mutated object by default; a new object if `registryConst: true` was passed). If the tx succeeds, use that registry directly and skip a discovery round-trip; replace it with fresh discovery before building the next tx.

```typescript
const result = await transfers.build(/* ... */).execute();
const receipt = await provider.waitForTransaction(txHash);
if (receipt.isSuccess()) {
  // Use result.registry directly — no need to re-discover
}
```

### Sequencing private transactions

Two constraints govern when you can prove the next private transaction:

1. **The prover reads finalized state, not `pre_confirmed`.** Your previous private tx's block must be finalized before you can prove the next one.
2. **The sequencer accepts proofs whose `base_block` is at least 10 blocks older than the submission block.** The proving block must sit within the acceptance window when the transaction arrives.

**Recipe:**

1. After each accepted private tx, record `lastTxBlockNumber = receipt.block_number`.
2. Before starting the next private tx, poll until `latestBlock - lastTxBlockNumber ≥ 10`.
3. Prove at `latestBlock - 10` (or a couple of blocks earlier, see comment) and submit.
4. Hide the wait behind a spinner — from the user's perspective the transaction just takes a bit longer.

```typescript
// Wait until the last tx block is finalized and old enough for the sequencer.
// getBlockNumber() returns the latest finalized block, so this loop covers
// both constraints: finalization and sequencer acceptance depth.
let latestBlock = await provider.getBlockNumber();
while (lastTxBlockNumber >= latestBlock - 10) {
  await sleep(blockTime);
  latestBlock = await provider.getBlockNumber();
}

// Prove at latest - 10 so the sequencer accepts it even after proving delay.
// Optimization: use 8–9 instead of 10 — proving takes ~4s, which is less than
// 1–2 block times, so the proof will still be within the window on arrival.
const provingBlock = latestBlock - 10;
const result = await transfers
  .build({
    autoDiscover: { notes: "refresh", channels: "refresh" },
    autoSelectNotes: "naive",
    provingBlockId: { block_number: provingBlock },
  })
  .with(STRK)
  .transfer({ recipient: bob, amount: 50n })
  .surplusTo(myAddress)
  .execute();

// Update tracking after the tx is accepted
const receipt = await provider.waitForTransaction(txHash);
lastTxBlockNumber = receipt.block_number;
```

The compiler forwards `provingBlockId` to discovery calls, ensuring the prover and discovery see the same contract state.

### Sequencing after transparent state changes

The same 10-block rule applies to **transparent** (non-private) transactions whose effects the pool will later need to prove against. Treat the receipt block of such a transaction exactly like `lastTxBlockNumber` in the previous recipe.

Two concrete cases:

- **Freshly deployed account → register.** You cannot call `register()` immediately after the account's deploy-account transaction. The prover must read the account's on-chain viewing-key slot at its base block; that slot only exists once the deploy is finalized. Wait ~10 blocks after the deploy receipt before registering.
- **Freshly topped-up account → deposit.** You cannot `deposit()` tokens into the pool in the same block (or within ~10 blocks) of the ERC-20 transfer that funded the account. The prover reads the depositor's token balance at its base block; if the transfer hasn't propagated to that base block, the proof is invalid or the deposit fails on-chain due to insufficient balance.

```typescript
// After topping up the account with tokens, wait before depositing into the pool.
const topupReceipt = await provider.waitForTransaction(topupTxHash);
const topupBlock = topupReceipt.block_number;

let latestBlock = await provider.getBlockNumber();
while (topupBlock >= latestBlock - 10) {
  await sleep(blockTime);
  latestBlock = await provider.getBlockNumber();
}

// Safe to deposit now.
const result = await transfers
  .build({ autoDiscover: { notes: "refresh", channels: "refresh" } })
  .with(STRK, (t) => t.deposit({ amount: 100n }))
  .surplusTo(self)
  .execute();
```

Rule of thumb: any on-chain state that the pool proof reads — account viewing key, depositor token balance, nullifier set — must have been written at least 10 blocks before the proof's base block.

## Configuration

### `createPrivateTransfers(params)`

| Parameter                 | Type                              | Description                                                                                  |
| ------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `account`                 | `PrivateTransfersUser`            | `{ address, signer }` used to sign proof invocations. A full `Account` is also assignable.   |
| `viewingKeyProvider`      | `ViewingKeyProvider`              | Provides the private viewing key used for encryption/decryption                              |
| `provingProvider`         | `ProofProviderInterface`          | Backend that generates validity proofs                                                       |
| `discoveryProvider`       | `DiscoveryProviderInterface`      | Backend for discovering notes and channels                                                   |
| `poolContractAddress`     | `StarknetAddress`                 | Address of the deployed privacy pool contract                                                |
| `proofInvocationFactory?` | `ProofInvocationFactoryInterface` | Optional override for proof invocation construction                                          |

### Discovery providers

**`ContractDiscoveryProvider`** — Queries the privacy pool contract directly via Starknet RPC. Best for development and testing.

```typescript
new ContractDiscoveryProvider(poolContract, { rateLimit?: { maxConcurrent, minDelay } });
```

**`IndexerDiscoveryProvider`** — Queries a discovery service via HTTP. Recommended for production; handles pagination and reorg detection.

```typescript
new IndexerDiscoveryProvider(apiUrl, contractAddress);
```

## Builder API

The builder provides a fluent interface for composing private operations. This is the recommended way to use the SDK.

### Register

```typescript
const result = await transfers.build().register().execute();
```

### Deposit

When depositing followed by other actions (transfers, withdrawals), omit the `recipient` on the deposit and use `surplusTo` to direct the remainder. This lets the SDK resolve all intermediate steps automatically.

```typescript
// Deposit to self (simple case)
const result = await transfers
  .build()
  .with(STRK, (t) => t.deposit({ amount: 100n }))
  .surplusTo(self)
  .execute();
```

### Deposit and transfer

```typescript
// Deposit 100, transfer 60 to bob — the SDK creates a 40 change note for self
const result = await transfers
  .build()
  .with(STRK, (t) => t.deposit({ amount: 100n }).transfer({ recipient: bob, amount: 60n }))
  .surplusTo(self)
  .execute();
```

### Transfer

```typescript
const result = await transfers
  .build()
  .with(STRK, (t) => t.inputs(note).transfer({ recipient: bob, amount: 50n }))
  .execute();
```

### Withdraw

```typescript
const result = await transfers
  .build()
  .with(STRK, (t) => t.inputs(note).withdraw({ amount: 30n }))
  .surplusTo(self)
  .execute();
```

### Multi-operation batch

```typescript
const result = await transfers
  .build()
  .with(STRK, (t) =>
    t.inputs(note100Strk).transfer({ recipient: alice, amount: 40n }).withdraw({ amount: 30n })
  )
  .surplusTo(self)
  .execute();
```

### Setup (open channel/subchannel)

```typescript
const result = await transfers
  .build()
  .setup(recipientAddress)
  .with(STRK, (t) => t.setup(recipientAddress))
  .execute();
```

`setup(recipient)` on the main builder opens a channel to the recipient. `setup(recipient)` on the token builder opens a token subchannel within that channel.

### Invoke external contract

```typescript
const result = await transfers.build()
  .with(STRK, (t) => t
    .inputs(strkNote)
    .withdraw({ recipient: swapAnonymizer, amount: 10n }))
  .with(BTC, (t) => t
    .deposit({ amount: Open, depositor: swapAnonymizer }))
  .invoke({ contractAddress: swapAnonymizer, entrypoint: "swap", calldata: [...] })
  .execute();
```

`invoke(callDetails)` adds an external contract call to the transaction. At most one `invoke()` per transaction.

### Anonymous swap (Ekubo)

Swap tokens privately by withdrawing the input token to a swap executor contract and receiving the output token as a private note. The executor performs the swap on Ekubo and deposits the output back into the privacy pool.

The flow: withdraw BTC to executor → executor swaps BTC→USD on Ekubo Router → executor deposits USD into an open note.

```typescript
import { Open } from "@starkware-libs/starknet-privacy-sdk";

const swapAmount = 10n * 10n ** 18n;

const { callAndProof } = await transfers
  .build({
    autoSetup: true,
    autoSelectNotes: "all",
    autoDiscover: { notes: "refresh", channels: "refresh" },
  })
  // Withdraw input token to the executor
  .with(BTC_TOKEN)
  .withdraw({ recipient: EXECUTOR_ADDRESS, amount: swapAmount })
  .surplusTo(self, false) // keep BTC change as a private note
  // Create an open note for the output token (amount filled by executor)
  .with(USD_TOKEN)
  .transfer({ recipient: self, amount: Open })
  .done()
  // Build the executor calldata — runs after note IDs are assigned
  .invoke((args) => ({
    contractAddress: EXECUTOR_ADDRESS,
    calldata: [
      EKUBO_ROUTER,
      BTC_TOKEN, // input token
      swapAmount, // input amount (i129 mag)
      0n, // i129 sign (positive = sell)
      POOL_TOKEN0, // pool key: token0
      POOL_TOKEN1, // pool key: token1
      POOL_FEE, // pool key: fee
      TICK_SPACING, // pool key: tick_spacing
      EXTENSION, // pool key: extension
      0n, // minimum_received (low)
      0n, // minimum_received (high)
      SKIP_AHEAD, // skip_ahead
      args.openNotes[0].noteId, // open note to fill with output
    ],
  }))
  .execute();
```

After the transaction settles, discover notes to see the USD output:

```typescript
const { notes } = await transfers.discoverNotes();
const usdNotes = notes.get(BigInt(USD_TOKEN)) ?? [];
```

### Anonymous lending (Vesu)

Deposit tokens into a Vesu lending pool privately and receive vToken shares as a private note. The lending anonymizer withdraws tokens from the privacy pool, deposits them into the Vesu vToken vault, and deposits the received shares back as an open note.

The flow: withdraw USD to anonymizer → anonymizer deposits USD into vToken vault → anonymizer deposits vUSD into an open note.

```typescript
import { Open } from "@starkware-libs/starknet-privacy-sdk";

const lendAmount = 50n * 10n ** 18n;

// Lend: USD → vUSD
const { callAndProof: lendCall } = await transfers
  .build({
    autoSetup: true,
    autoSelectNotes: "all",
    autoDiscover: { notes: "refresh", channels: "refresh" },
  })
  .with(USD_TOKEN)
  .withdraw({ recipient: ANONYMIZER_ADDRESS, amount: lendAmount })
  .surplusTo(self, false)
  .with(USD_VTOKEN)
  .transfer({ recipient: self, amount: Open })
  .done()
  .invoke((args) => ({
    contractAddress: ANONYMIZER_ADDRESS,
    calldata: [
      0n, // LendingOperation::Deposit
      USD_TOKEN, // underlying asset
      USD_VTOKEN, // vToken address
      lendAmount, // amount to deposit
      0n, // (reserved)
      args.openNotes[0].noteId,
    ],
  }))
  .execute();
```

To unlend (redeem vUSD shares back to USD), reverse the direction:

```typescript
// Discover vToken notes first
const { notes } = await transfers.discoverNotes();
const vTokenNotes = notes.get(BigInt(USD_VTOKEN)) ?? [];
const vTokenAmount = vTokenNotes.reduce((sum, n) => sum + n.amount, 0n);

// Unlend: vUSD → USD
const { callAndProof: unlendCall } = await transfers
  .build({
    autoSetup: true,
    autoSelectNotes: "all",
    autoDiscover: { notes: "refresh", channels: "refresh" },
  })
  .with(USD_VTOKEN)
  .withdraw({ recipient: ANONYMIZER_ADDRESS, amount: vTokenAmount })
  .surplusTo(self, false)
  .with(USD_TOKEN)
  .transfer({ recipient: self, amount: Open })
  .done()
  .invoke((args) => ({
    contractAddress: ANONYMIZER_ADDRESS,
    calldata: [
      1n, // LendingOperation::Withdraw
      USD_VTOKEN, // vToken to redeem
      USD_TOKEN, // underlying asset to receive
      lendAmount, // amount of underlying to withdraw
      0n, // (reserved)
      args.openNotes[0].noteId,
    ],
  }))
  .execute();
```

## Execute options

Pass options to `build()` or `execute()` to control automation:

```typescript
const result = await transfers
  .build({
    autoRegister: true,
    autoSetup: true,
    autoSelectNotes: "naive",
    autoDiscover: { notes: "refresh", channels: "refresh" },
    registry: myRegistry,
  })
  .with(STRK, (t) => t.transfer({ recipient: bob, amount: 50n }))
  .execute();
```

| Option            | Type                    | Description                                                                                                                                                      |
| ----------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoRegister`    | `boolean`               | Automatically register if user has no viewing key on-chain                                                                                                       |
| `autoSetup`       | `boolean`               | Automatically open channels and token subchannels as needed                                                                                                      |
| `autoSelectNotes` | `"all" \| "naive"`      | Automatically select input notes (`"all"` uses every note, `"naive"` selects minimum)                                                                            |
| `autoDiscover`    | `{ notes?, channels? }` | Refresh notes/channels before executing (`"missing"`, `"refresh"`, or `"all"`)                                                                                   |
| `registry`        | `PrivateRegistry`       | User's private state (channels, notes, cursor)                                                                                                                   |
| `registryConst`   | `boolean`               | If true, returns a new registry instead of mutating the provided one                                                                                             |
| `provingBlockId`  | `ProvingBlockId`        | Block identifier for proving and discovery — pins both note/channel discovery and proof generation to the same block state. Can be a block hash, number, or tag. |

## Discovery

### Check transfer readiness

```typescript
const requirement = await transfers.discoverRequirement(recipient, token);
// Returns: SetupRequirement.Register | SetupChannel | SetupToken | Ready
```

### Discover notes

```typescript
const { notes, timestamp } = await transfers.discoverNotes({
  tokens: [STRK],
  cursor: previousCursor,
  blockIdentifier: 42, // optional: pin reads to a specific block
});
// notes: AddressMap<Note[]> — unspent notes keyed by token address
```

### Discover channels

```typescript
const { timestamp, channels, total } = await transfers.discoverChannels("all", {
  cursor: previousCursor,
  blockIdentifier: "pre_confirmed", // optional: pin reads to a specific block
});
// channels: AddressMap<Channel> — channels keyed by recipient address
```

### Block identifier consistency

The optional `blockIdentifier` parameter pins storage reads to a specific block. Consistency guarantees depend on the type:

| Type                         | Consistency                                                          | Reorg detection              |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------- |
| Block hash (`"0x..."`)       | Full — identical state across all paginated requests                 | Yes (via `last_known_block`) |
| Block number (`42`)          | Stable height, but may reference a different branch after reorg      | No                           |
| Block tag (`"latest"`, etc.) | Best-effort — underlying block may change between paginated requests | No                           |

When `provingBlockId` is set in `ExecuteOptions`, the compiler automatically passes it as `blockIdentifier` to `discoverNotes` and `discoverChannels`, ensuring discovery and proving use the same block state.

### Transaction history

Fetch paginated transaction history and classify raw events into user-facing actions. Requires notes and channels to be discovered first.

```typescript
import { classifyTransaction } from "@starkware-libs/starknet-privacy-sdk";

const { notes, cursor: notesCursor } = await transfers.discoverNotes();
const { channels } = await transfers.discoverChannels("all");

// First page — blockIdentifier pins both storage reads and the event scan upper bound.
// Use "pre_confirmed" to include events from pre-confirmed blocks.
const page = await discovery.fetchHistory(
  userAddress,
  notesCursor,
  { channels },
  { maxTransactions: 10, blockIdentifier: "latest" }
);

for (const tx of page.transactions) {
  const { actions } = classifyTransaction(tx);
  for (const action of actions) {
    switch (action.type) {
      case "deposit": // { fromAddress, token, amount }
      case "withdrawal": // { toAddress, token, amount }
      case "transferSent": // { toAddress, token, amount, noteCount }
      case "transferReceived": // { fromAddress, token, amount, noteCount }
      case "swap": // { executor, sent: SwapLeg[], received: SwapLeg[] }
      case "transferSelf": // { token, amount, noteCount }
    }
  }
}

// Paginate with the returned cursor
if (!page.cursor.historyComplete) {
  const nextPage = await discovery.fetchHistory(
    userAddress,
    notesCursor,
    { channels },
    { maxTransactions: 10, historyCursor: page.cursor, blockIdentifier: page.blockRef }
  );
}
```

**Completeness caveats.** The history feed is anchored on the user's notes — each page scans backward one note block at a time and attaches the events that sit in that block. A few transaction shapes fall outside this anchor:

- **Bundled multi-user deposits** — when another user's deposit shares a transaction with your notes (atypical), it is filtered out of your history by `user_address` to avoid double-counting balances. Your own deposits in the same transaction still appear.
- **Notes above the cursor / `blockIdentifier` upper bound** — if the client-provided cursor or `blockIdentifier` disagrees with the actual block of a discovered note (stale cursor, malicious input, or chain drift), those notes are skipped silently and the scanner advances.

**Withdrawal attribution caveat.** On-chain `Withdrawal` events expose only the recipient address; the initiating `user_addr` is encrypted. The service cannot filter in-block withdrawals by initiator, so:

- A withdrawal that shares a transaction with your notes is attached to that transaction in your history, even if a different user initiated it (e.g. A withdraws to B while B has notes in the same tx).
- In multi-user batched transactions, unrelated withdrawals may be attached to any user with matched notes in the batch.

## Execute result

Every `execute()` call returns:

```typescript
type ExecuteResult = {
  callAndProof: CallAndProof; // Call + proof to send to the contract's execute_actions entry point
  registry: PrivateRegistry; // Updated notes and recipient info
  warnings: Warning[]; // Privacy leakage warnings
};
```

The wallet sends `callAndProof` in a transaction to the contract's `execute_actions` entry point. The returned `registry` can be reused in subsequent calls once the transaction is accepted and enough blocks have passed to make the state verifiable.

## Key types

**`Note`** — A private UTXO with an amount, token, and cryptographic witness.

**`Channel`** — A communication channel to a recipient, holding a shared key and per-token nonces.

**`PrivateRegistry`** — The user's local state: discovered channels, unspent notes, and a pagination cursor. Create with `createEmptyRegistry()`.

**`AddressMap<V>`** — A `Map` that normalizes Starknet addresses for consistent key lookup.

**`CallAndProof`** — A call + proof pair to send to the contract's `execute_actions` entry point.

**`Witness`** — Cryptographic witness for a note, used when spending.

**`SetupRequirement`** — Enum indicating what setup is needed before transferring: `Register`, `SetupChannel`, `SetupToken`, or `Ready`.

**`ExecuteOptions`** — Options controlling automation (auto-register, auto-setup, auto-discover, auto-select notes, registry, provingBlockId).

**`Warning`** — A privacy warning with a `WarningCode` and message. Currently defined code: `USER_LINKAGE`.

## Testing

The SDK exports testing utilities from `starknet-sdk/testing`:

```typescript
import {
  Devnet,
  createDevnetTestEnv,
  MockPoolContract,
  MockProofProvider,
} from "starknet-sdk/testing";
```

Key exports:

- **Devnet**: `Devnet`, `createDevnetTestEnv`, `DevnetConfig`, `DevnetEnvironment`, `DevnetTestEnv`
- **Mocks**: `MockPoolContract`, `MockProofProvider`, `MockProofInvocationFactory`, `MockSwapAnonymizer`, `MockContracts`, `Mocknet`, `ERC20`
- **Helpers**: `createMockProof`, `createMockCallAndProof`, `CallMockProofProvider`, `Withdrawal`
- **Hash functions**: `compute_channel_key`, `compute_channel_marker`, `compute_subchannel_id`, `compute_subchannel_marker`, `compute_note_id`, `compute_nullifier`, `compute_enc_amount_hash`, `compute_enc_token_hash`, `compute_enc_private_key_hash`, `compute_enc_user_addr_hash`, `compute_enc_channel_key_hash`, `compute_enc_sender_addr_hash`
- **Diagnostics**: `TracingRpcProvider`, `createConcurrencyProfiler`, `formatReport`
- **Discovery providers**: `ContractDiscoveryProvider`, `IndexerDiscoveryProvider`

## Internal flows

### Register flow

```mermaid
sequenceDiagram
    participant Wallet
    participant PrivateTransfers
    participant Prover as ProveInterface
    participant ProofProvider as ProofProviderInterface
    participant Paymaster as Paymaster

    Note over Wallet,Paymaster: Register Flow

    Wallet->>PrivateTransfers: register()

    rect rgba(100, 180, 100, 0.3)
        Note right of PrivateTransfers: 🟢 Internal
        PrivateTransfers->>PrivateTransfers: Create proof Call object<br/>pool.register(viewingKey)
    end

    rect rgba(100, 180, 100, 0.3)
        Note right of PrivateTransfers: 🟢 Internal
        PrivateTransfers->>Prover: prove(call)
    end

    rect rgba(220, 160, 80, 0.3)
        Note right of Prover: 🟠 Default impl (overridable)
        Prover->>Prover: Create Invocation from Call
        Prover->>Wallet: sign(invocation)
        Wallet-->>Prover: signedInvocation
    end

    rect rgba(200, 100, 100, 0.3)
        Note right of ProofProvider: 🔴 Backend Implementation
        Prover->>ProofProvider: prove(signedInvocation)
        ProofProvider-->>Prover: Proof
    end

    rect rgba(220, 160, 80, 0.3)
        Note right of Prover: 🟠 Default impl (overridable)
        Prover-->>PrivateTransfers: Proof
    end

    rect rgba(100, 180, 100, 0.3)
        Note right of PrivateTransfers: 🟢 Internal
        PrivateTransfers->>PrivateTransfers: Create starknet Call object
        PrivateTransfers-->>Wallet: CallAndProof
    end

    rect rgba(100, 130, 200, 0.3)
        Note right of Wallet: 🔵 Wallet
        Wallet->>Wallet: Create Invocation<br/>from CallAndProof
        Wallet->>Paymaster: submit(invocation)
    end
```

### Transfer flow

```mermaid
sequenceDiagram
    participant Wallet
    participant PrivateTransfers
    participant TokenNonce
    participant Prover as ProveInterface
    participant ProofProvider as ProofProviderInterface
    participant Paymaster as Paymaster

    Note over Wallet,Paymaster: Transfer Flow

    Wallet->>PrivateTransfers: transfer(recipient, token, inputs, amount?, selfChannel?)

    rect rgba(100, 180, 100, 0.3)
        Note right of PrivateTransfers: 🟢 Internal
        PrivateTransfers->>TokenNonce: next(recipient.channel.tokens[token])
        TokenNonce-->>PrivateTransfers: nonce
    end

    rect rgba(100, 180, 100, 0.3)
        Note right of PrivateTransfers: 🟢 Internal
        PrivateTransfers->>PrivateTransfers: Create proof Call object<br/>pool.transfer(..., nonce)
    end

    rect rgba(100, 180, 100, 0.3)
        Note right of PrivateTransfers: 🟢 Internal
        PrivateTransfers->>Prover: prove(call)
    end

    rect rgba(220, 160, 80, 0.3)
        Note right of Prover: 🟠 Default impl (overridable)
        Prover->>Prover: Create Invocation from Call
        Prover->>Wallet: sign(invocation)
        Wallet-->>Prover: signedInvocation
    end

    rect rgba(200, 100, 100, 0.3)
        Note right of ProofProvider: 🔴 Backend Implementation
        Prover->>ProofProvider: prove(signedInvocation)
        ProofProvider-->>Prover: Proof
    end

    rect rgba(220, 160, 80, 0.3)
        Note right of Prover: 🟠 Default impl (overridable)
        Prover-->>PrivateTransfers: Proof
    end

    rect rgba(100, 180, 100, 0.3)
        Note right of PrivateTransfers: 🟢 Internal
        PrivateTransfers->>PrivateTransfers: Create starknet Call object<br/>+ remainder Note (if amount < sum(inputs))
        PrivateTransfers-->>Wallet: PrivateInvocationResult
    end

    rect rgba(100, 130, 200, 0.3)
        Note right of Wallet: 🔵 Wallet
        Wallet->>Wallet: Create Invocation<br/>from CallAndProof
        Wallet->>Paymaster: submit(invocation)
    end

    rect rgba(100, 130, 200, 0.3)
        Note right of Wallet: 🔵 Wallet
        Wallet->>PrivateTransfers: discover({lastblock, recipient})
        PrivateTransfers-->>Wallet: PrivacyState (notes, recipients)
    end
```

## Starknet Devnet

SDK tests use [starknet-devnet](https://github.com/0xSpaceShard/starknet-devnet) v0.8.0-rc.3 (Starknet v0.14.2, RPC v0.10.1). Install from the release:

If you have a previous asdf installation of starknet-devnet, remove it first:

```bash
asdf plugin remove starknet-devnet
```

Then install from the release:

```bash
# macOS (Apple Silicon)
curl -L https://github.com/0xSpaceShard/starknet-devnet/releases/download/v0.8.0-rc.3/starknet-devnet-aarch64-apple-darwin.tar.gz -o /tmp/starknet-devnet.tar.gz
sudo tar -xzf /tmp/starknet-devnet.tar.gz -C /usr/local/bin
sudo chmod +x /usr/local/bin/starknet-devnet
rm /tmp/starknet-devnet.tar.gz

# Linux (x86_64)
curl -L https://github.com/0xSpaceShard/starknet-devnet/releases/download/v0.8.0-rc.3/starknet-devnet-x86_64-unknown-linux-gnu.tar.gz -o /tmp/starknet-devnet.tar.gz
sudo tar -xzf /tmp/starknet-devnet.tar.gz -C /usr/local/bin
sudo chmod +x /usr/local/bin/starknet-devnet
rm /tmp/starknet-devnet.tar.gz
```

Verify the installation:

```bash
which starknet-devnet
# Expected: /usr/local/bin/starknet-devnet
```

## Build

```bash
npm ci
npm run build
npm test
```

## OHTTP (Oblivious HTTP)

The SDK supports [Oblivious HTTP (RFC 9458)](https://datatracker.ietf.org/doc/html/rfc9458) for encrypting all communication with the discovery service at the application layer, independent of TLS.

When enabled, every request is encrypted with HPKE to the server's public key and sent as a `message/ohttp-req` payload. The response is returned as `message/ohttp-res` and decrypted client-side. The viewing key never appears in plaintext outside the OHTTP decryption layer.

### Enable OHTTP

```typescript
const discovery = new IndexerDiscoveryProvider(apiUrl, contractAddress, {
  ohttp: true,
});
```

The client fetches the server's HPKE public key from `GET /ohttp-keys` and caches it for 1 hour.

### Pin a key config

By default the client discovers the server's public key automatically via `GET /ohttp-keys`. If you want to pin the key config instead (e.g. for environments where the endpoint is not reachable, or to prevent TOFU trust-on-first-use), pass the raw bytes as `publicKeyConfig`:

```typescript
const discovery = new IndexerDiscoveryProvider(apiUrl, contractAddress, {
  ohttp: { publicKeyConfig: publicKeyConfigBytes },
});
```

`publicKeyConfig` is the binary `application/ohttp-keys` blob — the same bytes returned by `GET /ohttp-keys`. It contains the server's HPKE public key, key ID, and supported cipher suites (KEM, KDF, AEAD identifiers) as defined in [RFC 9458 §3](https://datatracker.ietf.org/doc/html/rfc9458#section-3).

To obtain it, fetch the endpoint once and save the response body:

```bash
curl -o ohttp-keys.bin https://discovery.example.com/ohttp-keys
```

Then load it in your application:

```typescript
import { readFileSync } from "fs";
const publicKeyConfigBytes = new Uint8Array(readFileSync("ohttp-keys.bin"));
```

### Use with an OHTTP relay

Route requests through an [OHTTP relay](https://github.com/cloudflare/privacy-gateway-relay) to hide client IP from the discovery service:

```typescript
const discovery = new IndexerDiscoveryProvider(apiUrl, contractAddress, {
  ohttp: { relayUrl: "https://relay.example.com" },
});
```

The relay hides the client's IP address from the discovery service. All
encapsulated requests are sent to the relay URL as-is — the specific API path
is encrypted inside the OHTTP envelope and is not visible to the relay. The
relay still sees request/response sizes and timing. The discovery service
itself decrypts and processes the full request.

### Proving service

`ProvingServiceProofProvider` supports the same OHTTP options:

```typescript
const prover = new ProvingServiceProofProvider(proverUrl, chainId, {
  ohttp: true,
});

// With relay and/or pinned key config:
const prover = new ProvingServiceProofProvider(proverUrl, chainId, {
  ohttp: { relayUrl: "https://relay.example.com", publicKeyConfig: keyBytes },
});
```

### Server requirements

Both the discovery service and the proving service must have OHTTP enabled:

```
OHTTP_ENABLED=true OHTTP_KEY=<hex-encoded-32-byte-x25519-private-key>
```

When the client has OHTTP enabled but the server does not, the `GET /ohttp-keys`
fetch will fail and the SDK will throw. Omit the `ohttp` option to use plaintext
JSON, or pin a `publicKeyConfig` to skip the key fetch.

### Security considerations

OHTTP encrypts request and response content but does **not** authenticate the
gateway by itself. The key config fetched from `GET /ohttp-keys` is trusted on
first use (TOFU). For production deployments:

- **Always use HTTPS** for `apiUrl`. The SDK warns at construction time if the
  URL is plain HTTP and no key config is pinned.
- **Pin the key config** via `publicKeyConfig` to avoid TOFU and remove the
  dependency on `GET /ohttp-keys` availability.

## See also

- [Project root](../README.md) — architecture overview, prerequisites, build commands
- [Privacy pool contract](../packages/privacy/README.md) — Cairo contract interfaces, actions, cryptographic primitives
- [Discovery service](../crates/discovery-service/README.md) — HTTP indexing service API
