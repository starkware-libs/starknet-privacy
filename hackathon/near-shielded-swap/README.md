# NEAR Shielded Swap

Cross-chain shielded swap for the Starknet privacy pool, routed via
[NEAR Intents](https://docs.near-intents.org/) (1Click).

> **Branch**: `avi/hackathon/near-anonymizer_part-5-plus-inbound`
> **Fork**: `git@github.com:avi-starkware/starknet-privacy.git`
> **Onboarding path**: read this README → run the app locally → read
> [`TODOS.md`](./TODOS.md) → pick a task.

---

## What this is

Two demoable flows that connect the Starknet privacy pool to the rest of the
crypto world without de-shielding mid-trip:

- **Withdraw** — user spends a shielded STRK note inside the Starknet
  privacy pool; STRK flows out through a per-swap anonymizer to NEAR
  Intents; ETH / USDC / SOL lands at a user-provided address on Ethereum
  or Solana. If 1Click fails, the STRK refund is sweep-back into a fresh
  shielded note — never lands publicly.

- **Deposit** — user holds ETH / USDC on Ethereum or SOL on Solana, sends
  it to a 1Click `depositAddress` from Metamask / Phantom; 1Click solvers
  deliver STRK to the anonymizer's per-swap *output mailbox* on Starknet;
  any caller invokes `anonymizer.finalize(swap_id)` to credit the user's
  pre-created open note. Funds enter the pool with no on-chain link to
  the source.

The "anonymizer" is a new Cairo contract (`NearIntentsAnonymizer`) that
sits between the privacy pool and 1Click. It manages two per-swap mailbox
addresses (one for output, one for refund) and orchestrates the lifecycle.

---

## Architecture

```
            ┌────────────────────────────────────────┐
            │  Starknet privacy pool                 │
            │  (already deployed at 0x030a18…77db)   │
            │                                        │
            │  • UseNote / CreateOpenNote / Withdraw │
            │  • deposit_to_open_note (new entry)    │
            │  • InvokeExternal                      │
            └────────┬────────────────────────┬──────┘
                     │                        │
        Tx 1 actions │           InvokeExternal│
                     ▼                        ▼
            ┌────────────────────────────────────────┐
            │  NearIntentsAnonymizer (singleton)     │
            │  packages/near_intents_anonymizer/     │
            │                                        │
            │  • privacy_invoke(...) ← Withdraw      │
            │  • register_inbound(...) ← Deposit     │
            │  • finalize(swap_id) ← claim           │
            │  • recover(swap_id) ← refund           │
            │                                        │
            │  pending_swaps[effective_swap_id]      │
            └──────────────┬─────────────────────────┘
                           │
            deploy_syscall │ on finalize / recover
                           ▼
            ┌────────────────────────────────────────┐
            │  MailboxReceiver (per-swap, lazy)      │
            │  Holds ERC-20 balance; only the        │
            │  anonymizer can sweep.                 │
            └────────────────────────────────────────┘

            ▲                                ▲
            │ Settlement                     │ User send
            │ (Starknet)                     │ (Ethereum / Solana)
            │                                │
            └────── NEAR Intents (1Click) ───┘
                    docs.near-intents.org
```

The mailbox addresses are **deterministic and computed off-chain** before
Tx 1 is even submitted: `output_mailbox(swap_id) = pedersen_chain(...)`.
The SDK passes that address to 1Click as the `recipient`. The receiver is
only actually deployed when `finalize` runs (lazy CREATE2-style).

---

## The two flows in detail

### Withdraw (pool → any chain)

```
Tx 1 (Starknet, signed by Argent X)
  ┌─────────────────────────────────────────────────────────────┐
  │ UseNote(STRK input note)                                    │
  │ CreateOpenNote(token=STRK, depositor=anonymizer, id=N_out)  │
  │ CreateOpenNote(token=STRK, depositor=anonymizer, id=N_ref)  │
  │ Withdraw(asset_in=STRK, to=anonymizer, amount)              │
  │ InvokeExternal(anonymizer.privacy_invoke(swap_id, …))       │
  └─────────────────────────────────────────────────────────────┘
                          │
                          │ Anonymizer forwards STRK to
                          │ 1Click's depositAddress on Starknet
                          ▼
                  ── NEAR Intents solvers ──
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
  Success: ETH lands           Failure: STRK lands at
  at user's Eth address        refund_mailbox(swap_id)
  (no Starknet tx needed)      ── anyone calls ──
                               anonymizer.recover(swap_id)
                               → pool.deposit_to_open_note(N_ref, STRK, x)
                               → user keeps shielded balance ✓
```

The output mailbox is *unused* on Withdraw success (the output goes off
Starknet). On failure, the refund mailbox is the safety mechanism that
keeps shielding intact.

### Deposit (any chain → pool)

```
Tx 1 (Starknet, signed by Argent X)
  ┌─────────────────────────────────────────────────────────────┐
  │ SetViewingKey* / OpenChannel* / OpenSubchannel*             │
  │ CreateOpenNote(token=STRK, depositor=anonymizer, id=N)      │
  │ InvokeExternal(anonymizer.register_inbound(swap_id, …))     │
  └─────────────────────────────────────────────────────────────┘
                          │
                          │ Anonymizer records:
                          │   pending_swaps[effective_swap_id]
                          │     = { asset_out=STRK, note_id_out=N,
                          │         status=Pending }
                          ▼
  Source send (Ethereum or Solana, signed by Metamask / Phantom)
  ┌─────────────────────────────────────────────────────────────┐
  │ transfer X ETH (or USDC, or SOL) to 1Click depositAddress   │
  └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
                  ── NEAR Intents solvers ──
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
  Success: STRK lands         Failure: ETH / SOL refund
  at output_mailbox(eff_id)   to user's external wallet
  on Starknet                 (no Starknet action needed —
                              the source-chain refund lives off Starknet)
          │
  Tx 2 (Starknet, anyone can submit)
  ┌─────────────────────────────────────────────────────────────┐
  │ anonymizer.finalize(effective_swap_id)                      │
  │   → deploy MailboxReceiver at output_mailbox                │
  │   → mailbox.sweep(STRK) → anonymizer                        │
  │   → IERC20.approve(pool, swept)                             │
  │   → pool.deposit_to_open_note(N, STRK, swept) ✓             │
  └─────────────────────────────────────────────────────────────┘
```

`effective_swap_id = pedersen(caller, swap_id)` — anti-griefing so two
users can't collide on the same raw `swap_id`. The SDK does the
derivation off-chain to keep `output_mailbox` calls / finalize calls
consistent.

---

## Layout

```
hackathon/near-shielded-swap/             ← this directory
├── README.md                             ← you are here
├── TODOS.md                              ← prioritized punch list
└── app/                                  ← React + Vite + TS UI
    ├── src/
    │   ├── components/
    │   │   ├── SwapCard.tsx              wrapper; Withdraw ⇄ Deposit toggle
    │   │   ├── WithdrawForm.tsx          pool → any chain
    │   │   ├── DepositForm.tsx           any chain → pool
    │   │   ├── DepositProgress.tsx       4-step status timeline
    │   │   ├── TokenSelector.tsx         token + chain picker
    │   │   ├── BrandIcon.tsx             STRK / ETH / USDC / SOL SVGs
    │   │   ├── WalletButton.tsx          Argent X pill in TopBar
    │   │   ├── SwapTimeline.tsx          pending swaps list (mock)
    │   │   ├── TopBar.tsx                navbar
    │   │   └── …
    │   ├── hooks/
    │   │   ├── useWallet.tsx             Starknet (starknetkit) + identity
    │   │   ├── useEthWallet.ts           Metamask via window.ethereum
    │   │   ├── useSolanaWallet.ts        Phantom via window.solana
    │   │   ├── useSourceWallet.ts        dispatcher: chainTag → wallet
    │   │   ├── useEthSend.ts             Metamask transfer to depositAddress
    │   │   ├── useSolanaSend.ts          Phantom transfer
    │   │   ├── useWithdrawSubmit.ts      Tx 1 composer → Argent X
    │   │   ├── useOneClickStatus.ts      Settlement poller
    │   │   └── useQuote.ts               Debounced 1Click quote fetcher
    │   ├── lib/
    │   │   ├── chain.ts                  Chain config + addresses
    │   │   ├── anonymizer.ts             Mailbox derivation + calldata
    │   │   ├── oneclick.ts               1Click SDK wrapper
    │   │   ├── oneclick-status.ts        Status classifiers + poller
    │   │   ├── pool-builder.ts           SDK-driven Tx 1 composer
    │   │   ├── eth-send.ts               ERC-20 calldata helpers
    │   │   ├── sol-send.ts               Solana transaction helpers
    │   │   ├── identity.ts               Sign-to-derive viewing keypair
    │   │   ├── addresses.ts              Chain-aware address validation
    │   │   ├── solana-rpc.ts             Solana mainnet RPC constant
    │   │   └── format.ts                 Number / USD formatters
    │   └── mocks/
    │       ├── tokens.ts                 Source + destination catalog
    │       └── pendingSwaps.ts           Mock pending list (TODO: real)
    ├── package.json                      starknet-sdk: file:../../../sdk
    ├── tailwind.config.js                Brand tokens + animations
    ├── vite.config.ts                    Port 5180, alias setup
    └── …
```

The Cairo contracts (`NearIntentsAnonymizer` + `MailboxReceiver`) live in
the privacy-pool monorepo at **`packages/near_intents_anonymizer/`** —
they have their own README and integrate via the pool's `InvokeExternal`
mechanism and the `deposit_to_open_note` entrypoint (added on the
`hackathon/privacy-pool/unfilled-open-note-support` branch which this
branch is based on).

---

## Quickstart

### Prerequisites

- Node 20+ and npm
- The privacy-pool SDK built once: `cd ../../../sdk && npm install && npm run build`
- For Cairo work: `scarb` and `snforge` per `.tool-versions`

### Run the UI

```bash
cd hackathon/near-shielded-swap/app
npm install
npm run dev          # http://localhost:5180
```

### Run the tests

```bash
# UI / SDK helpers / hooks
cd hackathon/near-shielded-swap/app
npm test             # vitest — 49 passing

# Cairo contracts
cd ../../..          # repo root
snforge test --package near_intents_anonymizer        # 52 passing
snforge test --package privacy test_near_intents      # 4 passing
```

If `snforge` isn't on PATH, the version is pinned in `.tool-versions`:

```bash
PATH="$HOME/.cargo/bin:$PATH" mise exec -- snforge test --package near_intents_anonymizer
```

### Build

```bash
cd hackathon/near-shielded-swap/app
npm run build        # tsc -b && vite build
npm run typecheck    # standalone TS check
```

---

## Configuration

`app/src/lib/chain.ts` is the single source of truth for chain + service
wiring. Mainnet by default:

| Constant | Value | Notes |
|---|---|---|
| `CHAIN.chainId` | `0x534e5f4d41494e` (SN_MAIN) | |
| `CHAIN.rpcUrl` | `http://34.61.242.43:9545/rpc/v0_10` | Team Pathfinder; HTTP not HTTPS — fine for localhost, needs proxy if deployed on HTTPS |
| `POOL_CONTRACT_ADDRESS` | `0x030a18…77db` | Verified on-chain; matches `POOL_CLASS_HASH` |
| `POOL_CLASS_HASH` | `0x06fbd0…42e3` | |
| `PROVING_SERVICE_URL` | `http://35.232.252.204:3000` | |
| `DISCOVERY_SERVICE_URL` | `http://34.56.72.86:8080` | Verified live; indexes the pool above |
| `STRK_TOKEN_ADDRESS` | `0x04718f…938d` | Canonical Starknet STRK |
| `ANONYMIZER_ADDRESS` | **`0x…aaa`** (placeholder) | Will be set post-deploy — see TODOS |
| `RECEIVER_CLASS_HASH` | **`0x…bbb`** (placeholder) | Same |

The Sepolia pool at `0x00c3b88…ef5574` shares the same class hash — useful
for smoke-testing before mainnet.

---

## Key design decisions (why we did what)

### Sign-to-derive shielded identity

The user's pool viewing key is **derived from a typed-data signature** of
their Starknet wallet (`app/src/lib/identity.ts`). Same wallet + same
SNIP-12 message ⇒ same viewing key, deterministically. The private key
never leaves browser memory and is never persisted (the public key
fingerprint is shown only as confirmation).

Canonical-fold matches the pool's `is_canonical_key` constraint
(`1 ≤ k < ORDER/2`). Mirrors `demo/src/session.ts:deriveViewingKey` but
sources entropy from a wallet signature instead of a raw private key.

### Counterfactual mailbox addresses

`output_mailbox(swap_id)` and `refund_mailbox(swap_id)` are
**Starknet contract addresses** computed deterministically from the
anonymizer's address + receiver class hash + a domain-separated salt
(`pedersen('NIA_OUTPUT_V1', swap_id)` / `pedersen('NIA_REFUND_V1', swap_id)`).

ERC-20 transfers can land at the address before any contract is deployed
there. The `MailboxReceiver` is only deployed when `finalize` or
`recover` runs (lazy CREATE2). Saves gas on the failure path (refund
mailbox never gets deployed on a successful swap) and gives every swap
its own isolated receiver — critical for safety under concurrent failed
swaps.

Off-chain derivation in TS (`app/src/lib/anonymizer.ts`) is pinned
byte-for-byte against on-chain `compute_address` via Cairo SDK-parity
fixtures (`packages/near_intents_anonymizer/src/tests/test_sdk_parity.cairo`).

### `register_inbound` anti-griefing

`pending_swaps` is keyed by `effective_swap_id = pedersen(caller, swap_id)`.
Two users can pick the same raw `swap_id` without colliding. The SDK
must use `effective_swap_id` for all subsequent calls (`output_mailbox`,
`finalize`, `get_swap`) — the contract exposes a view
`compute_effective_swap_id(user, swap_id)` to verify off-chain parity.

### Native wallet integration (no wagmi / no @solana/wallet-adapter)

We talk directly to `window.ethereum` and `window.solana`. Saves
~250 KB gz of wallet-library overhead and lets us share a uniform
state-machine shape across Argent X, Metamask, and Phantom. See
`useEthWallet`, `useSolanaWallet`, `useSourceWallet`.

---

## Open issues / known limitations

1. **`ANONYMIZER_ADDRESS` and `RECEIVER_CLASS_HASH` are placeholders.**
   Until the anonymizer is declared + deployed, mailbox addresses
   computed off-chain are stable but meaningless. Mailbox-keyed 1Click
   recipients will not be sweepable.

2. **Input note in Withdraw is a stub.** `useWithdrawSubmit` synthesizes
   an all-zero witness `Note` of the requested amount. The prover will
   reject this on a real run. Replace with notes from
   `transfers.discoverNotes()` when wired.

3. **`starknet.js` major-version straddle.** SDK pins v10; the UI pins v8
   (starknetkit's peer). They coexist via npm's nested install. Two
   `as unknown as Account` casts in `pool-builder.ts` bridge the type
   gap. Runtime is stable — same JSON-RPC surface.

4. **Deposit Tx 1 is not yet wired.** `DepositForm.tsx` has a TODO where
   the Starknet setup tx (`CreateOpenNote + register_inbound`) should
   go. The Metamask / Phantom send pops correctly; the on-chain leg
   needs the SDK helpers (`registerInboundCalldata`, `effectiveSwapId`)
   to be added first.

5. **Refund / claim relayer.** `finalize` and `recover` are
   permissionless — anyone can submit. Today the user is expected to
   click "Claim shielded note" themselves. A keeper bot watching the
   mailbox addresses would close the loop without user action; not
   built yet.

6. **Events leak swap amounts.** `SwapStarted` / `SwapFinalized` /
   `InboundRegistered` carry plaintext amounts. Identity privacy is
   preserved; aggregate-volume privacy isn't. Hashed-only events are
   future work.

---

## References

- [Privacy pool integration plan](../../docs/near-intents-integration-plan.md)
- [Mainnet pool deploy runbook](../../docs/mainnet-pool-deploy-runbook.md)
- [Cairo contracts (anonymizer)](../../packages/near_intents_anonymizer/)
- [Privacy pool source](../../packages/privacy/)
- [Adding tokens to NEAR Intents](../../docs/adding-starknet-tokens-to-near-intents.md)
- [1Click API docs](https://docs.near-intents.org/)
- [Starknet privacy pool repo (upstream)](https://github.com/starkware-libs/starknet-privacy)
