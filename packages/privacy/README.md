# Privacy Pool Contract

Cairo smart contract implementing the privacy pool protocol.

## Contract interfaces

### IClient

User transaction entry point. `__execute__` validates context, compiles `ClientAction`s into `ServerAction`s, and sends them to L1. `compile_actions` compiles actions without side effects. Phase ordering is enforced.

### IServer

`apply_actions` applies server actions atomically (storage writes, token transfers, events). Protected by a reentrancy guard. Collects a fee (if configured) before applying actions. Validates proof facts from transaction info (program variant, block validity, message hash). Requires contract unpaused.

`deposit_to_open_note` fills a pre-created open note with tokens. Caller must be the depositor specified when the note was created. Emits `OpenNoteDeposited`. Requires contract unpaused.

### IViews

Read-only queries: channel/subchannel existence, note lookup, nullifier checks, public key retrieval, fee info.

### IAdmin

Governance: auditor public key, depositor block list, fee amount, fee collector. Access-controlled to security governor / app governor.

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

- All hashes use Poseidon with domain-separation tags (see [`hashes.cairo`](src/hashes.cairo) for formulas)
- Key derivations: `channel_key`, `channel_marker`, `subchannel_marker`, `subchannel_id`, `outgoing_channel_id`, `note_id`, `nullifier`
- Encryption: ECDH with ephemeral keys; encrypted fields include channel keys, addresses, note amounts, tokens, and private keys

## Security

- **Reentrancy guard**: `apply_actions()` is protected by OpenZeppelin's `ReentrancyGuardComponent`. Reentrant calls (e.g. via `InvokeExternal` callbacks) are rejected.
- **Pausable**: Both `apply_actions()` and `deposit_to_open_note()` require the contract to be unpaused (`PausableComponent`).
- **Access control**: Admin functions use role-based access via `RolesComponent` and `AccessControlComponent`. `set_auditor_public_key` and `set_depositor_blocked` require `security_governor` role. `set_fee_amount`, `set_fee_collector`, and `set_proof_validity_blocks` require `app_governor` role.
- **Replaceability**: Contract supports upgrades via `ReplaceabilityComponent`.

## Fees

`apply_actions()` collects a fee in STRK (FRI) before applying actions.

| Function | Access | Description |
|----------|--------|-------------|
| `get_fee_amount()` | public | Returns fee per `apply_actions` call (0 = disabled) |
| `set_fee_amount(fee_amount)` | app_governor | Set fee; fee collector must be non-zero when fee is non-zero |
| `get_fee_collector()` | public | Returns address receiving fees |
| `set_fee_collector(fee_collector)` | app_governor | Set fee collector; fee amount must be zero when clearing collector |

## Proof validation

`apply_actions()` validates proof facts from transaction info before applying actions:

1. Deserializes `ProofFacts` from transaction info (errors: `EMPTY_PROOF_FACTS`, `PROOF_FACTS_DESERIALIZE_ERROR`, `INVALID_PROOF_FACTS`)
2. Validates program variant is `VIRTUAL_SNOS` (error: `INVALID_PROGRAM_VARIANT`)
3. Validates OS output version is `VIRTUAL_SNOS0` (error: `INVALID_OS_OUTPUT_VERSION`)
4. Validates base block number < current block (error: `INVALID_BASE_BLOCK_NUMBER`)
5. Validates proof is within `proof_validity_blocks` of base block (error: `PROOF_EXPIRED`)
6. Validates message hash matches actions (error: `INVALID_PROOF_MSG`)

`set_proof_validity_blocks(blocks)` (app_governor) configures the proof expiry window. Emits `ProofValidityBlocksSet`.

## Events

| Event | Emitted by |
|-------|------------|
| `ViewingKeySet` | `SetViewingKey` action |
| `Deposit` | `Deposit` action |
| `Withdrawal` | `Withdraw` action |
| `NoteUsed` | `UseNote` action |
| `OpenNoteCreated` | `CreateOpenNote` action |
| `OpenNoteDeposited` | `deposit_to_open_note()` |
| `AuditorPublicKeySet` | `set_auditor_public_key()` |
| `FeeAmountSet` | `set_fee_amount()` |
| `FeeCollectorSet` | `set_fee_collector()` |
| `ProofValidityBlocksSet` | `set_proof_validity_blocks()` |

## Source modules

| File | Purpose |
|------|---------|
| [`interface.cairo`](src/interface.cairo) | Public traits (IClient, IServer, IViews, IAdmin) |
| [`actions.cairo`](src/actions.cairo) | ClientAction / ServerAction enums and input structs |
| [`objects.cairo`](src/objects.cairo) | On-chain types: Note, EncChannelInfo, EncSubchannelInfo, etc. |
| [`hashes.cairo`](src/hashes.cairo) | Domain-separated Poseidon hash functions |
| [`events.cairo`](src/events.cairo) | Contract events (ViewingKeySet, Deposit, Withdrawal, etc.) |
| [`privacy.cairo`](src/privacy.cairo) | Contract implementation |
| [`errors.cairo`](src/errors.cairo) | Error constants |
| [`utils.cairo`](src/utils.cairo) | Internal utilities and constants |

## Build and test

```bash
scarb build
scarb test   # wraps snforge test
```

snforge version: `0.59.0`

Reference data generation: [`tests/generate_reference_data.cairo`](src/tests/generate_reference_data.cairo)

## Declare and deploy with sncast

[sncast](https://foundry-rs.github.io/starknet-foundry/) (Starknet Foundry) can declare and deploy the contract. Run from the **repository root** (workspace has multiple packages) and use an [account](https://foundry-rs.github.io/starknet-foundry/appendix/sncast/account.html) configured in `snfoundry.toml` or via `--account` / `--url`.

**1. Declare the contract**

```bash
scarb --profile release build
sncast --account <ACCOUNT_NAME> declare \
  --contract-name Privacy \
  --package privacy \
  --network <mainnet|sepolia|devnet>
```

If you use a custom RPC instead of a preset network, use `--url <RPC_URL>` instead of `--network`. The command prints the **class hash**; use it for deploy.

**2. Deploy the contract**

Constructor arguments: `governance_admin` (address), `auditor_public_key` (felt252), `proof_validity_blocks` (u64).

```bash
sncast --account <ACCOUNT_NAME> deploy \
  --class-hash <CLASS_HASH_FROM_DECLARE> \
  --constructor-calldata <GOVERNANCE_ADMIN_ADDRESS> <AUDITOR_PUBLIC_KEY> <PROOF_VALIDITY_BLOCKS> \
  --network <mainnet|sepolia|devnet>
```

Replace `<GOVERNANCE_ADMIN_ADDRESS>` with the Starknet address that will hold governance (e.g. the deployer). Use your auditor’s public key for `<AUDITOR_PUBLIC_KEY>` and the proof validity window in blocks for `<PROOF_VALIDITY_BLOCKS>` (e.g. `450` for ~15 min at 2s/block).

You can pass `--salt <FELT>` for a deterministic address or `--unique` to include the deployer in the salt.

## See also

- [Project root](../../README.md) — architecture overview, prerequisites, build commands
- [TypeScript SDK](../../sdk/README.md) — client-side private transfers API
- [Discovery core](../../crates/discovery-core/README.md) — Rust library for storage slot computation and discovery logic