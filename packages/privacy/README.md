# Privacy Pool Contract

Cairo smart contract implementing the privacy pool protocol. Source of truth for contract interface, storage layout, and cryptographic primitives.

## Contract interfaces

### IClient

User transaction entry point. `__execute__` validates context, compiles `ClientAction`s into `ServerAction`s, and sends them to L1. `execute_view` compiles actions without side effects. Phase ordering is enforced.

### IServer

`apply_actions` applies server actions atomically (storage writes, token transfers, events). `deposit_to_open_note` fills pre-created open notes. Requires contract unpaused.

### IViews

Read-only queries: channel/subchannel existence, note lookup, nullifier checks, public key retrieval, fee info.

### IAdmin

Governance: auditor public key, fee amount, fee collector. Access-controlled to token admin / app governor.

## Client action phases

Actions must be ordered by phase. Actions within the same phase can appear in any order, but must not regress to an earlier phase.

| Phase | Action | Description |
|-------|--------|-------------|
| 0 | `SetViewingKey` | Register or replace viewing key |
| 1 | `OpenChannel` | Open channel to recipient |
| 2 | `OpenSubchannel` | Open token-specific subchannel |
| 3 | `Deposit` | Deposit tokens into contract |
| 4 | `UseNote` | Spend a note (creates nullifier) |
| 5 | `CreateEncNote` | Create encrypted note |
| 5 | `CreateOpenNote` | Create open (unencrypted) note |
| 6 | `Withdraw` | Withdraw tokens |
| 7 | `InvokeExternal` | Call external contract (at most once per tx) |

## Cryptographic primitives

- All hashes use Poseidon with domain-separation tags (see `hashes.cairo` for formulas)
- Key derivations: `channel_key`, `channel_marker`, `subchannel_marker`, `subchannel_id`, `outgoing_channel_id`, `note_id`, `nullifier`
- Encryption: ECDH with ephemeral keys; encrypted fields include channel keys, addresses, note amounts, tokens, and private keys

## Source modules

| File | Purpose |
|------|---------|
| `interface.cairo` | Public traits (IClient, IServer, IViews, IAdmin) |
| `actions.cairo` | ClientAction / ServerAction enums and input structs |
| `objects.cairo` | On-chain types: Note, EncChannelInfo, EncSubchannelInfo, etc. |
| `hashes.cairo` | Domain-separated Poseidon hash functions |
| `events.cairo` | Contract events (ViewingKeySet, Deposit, Withdrawal, etc.) |
| `privacy.cairo` | Contract implementation |
| `errors.cairo` | Error constants |
| `utils.cairo` | Internal utilities and constants |

## Build and test

```bash
scarb build
scarb test   # wraps snforge test
```

snforge version: `0.55.0+nightly-2026-02-20`

Reference data generation: `tests/generate_reference_data.cairo`