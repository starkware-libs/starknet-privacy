# NEAR Shielded Swap

Hackathon project: bridge between the Starknet privacy pool and 1Click
(NEAR Intents) so a user can move STRK in and out of the shielded pool
across Ethereum and Solana, with the swap leg breaking the on-chain link
between their shielded balance and the source/destination.

Two flows, both shielded end-to-end on the Starknet side:

- **Withdraw** (`pool → any chain`): user spends a shielded STRK note,
  the anonymizer forwards STRK to a 1Click `depositAddress`, 1Click solvers
  deliver ETH / USDC / SOL to a user-provided address on the destination
  chain. If 1Click refunds, STRK lands at a per-swap *refund mailbox* and
  any caller invokes `anonymizer.recover(swap_id)` to credit a fresh
  shielded refund note in the pool. The user's STRK never lands publicly.

- **Deposit** (`any chain → pool`): user sends ETH on Ethereum / SOL on
  Solana to a 1Click `depositAddress` via Metamask / Phantom, 1Click solvers
  deliver STRK to the anonymizer's per-swap *output mailbox* on Starknet,
  any caller invokes `anonymizer.finalize(swap_id)` to sweep + fill the
  user's pre-created open note via the pool's `deposit_to_open_note`. The
  user's funds enter the pool with no on-chain linkage to the source.

## Layout

```
hackathon/near-shielded-swap/
├── README.md                     ← you are here
├── app/                          ← React + Vite + TS UI (this dir)
│   ├── src/
│   │   ├── components/           SwapCard, WithdrawForm, DepositForm, ...
│   │   ├── hooks/                useWallet, useEthSend, useSolanaSend,
│   │   │                         useWithdrawSubmit, useOneClickStatus, ...
│   │   ├── lib/                  anonymizer (mailbox derivation), oneclick,
│   │   │                         pool-builder, identity, chain config, ...
│   │   └── mocks/
│   └── package.json              ← `starknet-sdk: file:../../../sdk`
└── (contracts)                   ← lives at packages/near_intents_anonymizer/
```

The Cairo contracts (`NearIntentsAnonymizer` + `MailboxReceiver`) live with
the rest of the privacy-pool monorepo at
**`packages/near_intents_anonymizer/`** — they integrate with `packages/privacy/`
via the pool's `InvokeExternal` mechanism and the new
`deposit_to_open_note` entrypoint (branch:
`hackathon/privacy-pool/unfilled-open-note-support`).

## Running the app

```bash
cd hackathon/near-shielded-swap/app
npm install
npm run dev          # http://localhost:5180
```

Pre-flight: the SDK at `sdk/` must be built once (`cd sdk && npm install &&
npm run build`) since `app/` links to it via `file:../../../sdk`.

## Tests

```bash
# TS — SDK helpers + UI hooks
cd hackathon/near-shielded-swap/app && npm test           # 49 passing

# Cairo — anonymizer unit + privacy-pool integration
snforge test --package near_intents_anonymizer            # 52 passing
snforge test --package privacy test_near_intents          # 4 passing
```

## Configuration

Mainnet wired by default — see `app/src/lib/chain.ts`:

| Field | Value |
|---|---|
| `CHAIN.chainId` | `0x534e5f4d41494e` (SN_MAIN) |
| `CHAIN.rpcUrl` | `http://34.61.242.43:9545/rpc/v0_10` |
| `POOL_CONTRACT_ADDRESS` | `0x030a18…77db` (deployed mainnet pool, verified) |
| `POOL_CLASS_HASH` | `0x06fbd0…42e3` |
| `PROVING_SERVICE_URL` | `http://35.232.252.204:3000` |
| `DISCOVERY_SERVICE_URL` | `http://34.56.72.86:8080` |
| `STRK_TOKEN_ADDRESS` | `0x04718f…938d` |
| `ANONYMIZER_ADDRESS` | **TODO** — placeholder `0x…aaa` until anonymizer is deployed |
| `RECEIVER_CLASS_HASH` | **TODO** — placeholder `0x…bbb` until receiver class is declared |

## What works end-to-end today

- Live cross-chain quotes (real 1Click prices, both directions)
- Multi-wallet UX: Argent X / Braavos (Starknet), Metamask (Ethereum),
  Phantom (Solana)
- Sign-to-derive shielded identity (typed-data signature → viewing keypair)
- Withdraw composes the full pool Tx 1 calldata and pops Argent X
- Deposit composes the source-chain transfer and pops Metamask / Phantom,
  with a 4-step status timeline polling 1Click

## What's still TODO before a real demo

1. **Deploy `NearIntentsAnonymizer` + `MailboxReceiver`** to mainnet and
   plug the addresses into `chain.ts`. Runbook at
   `../docs/mainnet-pool-deploy-runbook.md`, deploy script at
   `e2e/scripts/deploy-near-intents-anonymizer.ts`.
2. **Add TS SDK helpers** for `register_inbound` (the new Cairo entry
   point): `registerInboundCalldata(...)`, `effectiveSwapId(user, swap_id)`,
   plus parity tests against Cairo fixtures.
3. **Wire Deposit Tx 1**: replace the TODO in `DepositForm.tsx` with a
   `SetViewingKey* + OpenChannel* + CreateOpenNote(STRK, depositor=anonymizer)
   + InvokeExternal(register_inbound)` Starknet tx before dispatching to
   Metamask / Phantom.
4. **Replace the input-note stub** in `useWithdrawSubmit` with real notes
   discovered via `transfers.discoverNotes()`.
5. **starknet.js v8 ↔ v10 boundary** — the app pins v8 (starknetkit's peer)
   while the SDK ships v10. The `as unknown as Account` casts in
   `pool-builder.ts` are tech debt; consolidate on one major version.
6. **Sepolia smoke** before any mainnet swap.

## References

- Cairo contracts: `packages/near_intents_anonymizer/`
- SDK boundary: `packages/near_intents_anonymizer/README.md`
- Integration plan: `docs/near-intents-integration-plan.md`
- Mainnet pool deploy runbook: `docs/mainnet-pool-deploy-runbook.md`
- 1Click docs: <https://docs.near-intents.org/>
