# NEAR Intents Anonymizer

Anonymous cross-chain swap helper bridging the Starknet privacy pool to
[NEAR Intents](https://docs.near-intents.org/). Lets a user holding shielded
notes in the pool send funds through 1Click to a destination chain (e.g.
Ethereum, Solana) and receive the proceeds back into the pool as a fresh
shielded note, with no on-chain link between input and output.

Requires the privacy pool's `unfilled-open-note-support` feature: the
`depositor` field on `Note` and the public `deposit_to_open_note`
entrypoint added on `hackathon/privacy-pool/unfilled-open-note-support`.

## Architecture

Two contracts:

- **`NearIntentsAnonymizer`** (singleton) — orchestrates the swap. Holds
  per-swap state, dispatches to NEAR Intents on initiation, sweeps + credits
  the user's pre-allocated open note on settlement.
- **`MailboxReceiver`** (per-(swap × leg)) — ERC-20 holding contract
  deployed lazily by the anonymizer via `deploy_syscall` at a deterministic
  address. Only the anonymizer can sweep it. NEAR Intents delivers
  settlement proceeds here via a plain ERC-20 transfer (no contract
  required at the destination address until sweep time).

The flow is two transactions:

```
Tx 1 (Dispatch, pool tx, user-signed)
   UseNote(input)                                       ─┐
   CreateOpenNote(asset_out, depositor=anonymizer)       │  atomic
   CreateOpenNote(asset_in,  depositor=anonymizer)       │
   Withdraw(asset_in → anonymizer, in_amount)            │
   InvokeExternal(anonymizer.privacy_invoke(...))       ─┘

[off-chain]  NEAR Intents settles. Output (or refund) lands at one of
             the two precomputed mailbox addresses.

Tx 2a (Finalize, plain tx, ANY signer)
   anonymizer.finalize(swap_id)
     → deploy_syscall(MailboxReceiver, output_salt(swap_id), …)
     → mailbox.sweep(asset_out)              # mailbox → anonymizer
     → IERC20.approve(pool, swept)
     → pool.deposit_to_open_note(note_id_out, asset_out, swept)
                                              # anonymizer → pool → note

Tx 2b (Recover, plain tx, ANY signer) — alternative to Tx 2a if NEAR fails
   anonymizer.recover(swap_id)
     → same shape on refund_salt(swap_id), credits refund_note_id
```

`finalize` and `recover` are mutually exclusive per swap (status flag +
`deploy_syscall(deploy_from_zero=false)` collision protection at the same
salt).

## SDK integration — single source of truth

Everything the SDK needs to interoperate with this package. **Pinning
these is a coordination contract**: any change requires the SDK fixture
file to update in lockstep.

### Addresses (per deployment)

| Name | How to get |
|---|---|
| `ANONYMIZER_ADDRESS` | `e2e/.env.deployed` after running `npm run deploy-near-intents-anonymizer`. |
| `RECEIVER_CLASS_HASH` | Same file. Class hash never changes for a given binary. |

### Salt-domain constants (must match byte-for-byte in SDK)

```
OUTPUT_SALT_DOMAIN = 'NIA_OUTPUT_V1'   # felt252 short-string
REFUND_SALT_DOMAIN = 'NIA_REFUND_V1'
```

Per-swap salts:
```
output_salt(swap_id) = pedersen('NIA_OUTPUT_V1', swap_id)
refund_salt(swap_id) = pedersen('NIA_REFUND_V1', swap_id)
```

### Mailbox-address derivation (off-chain replica)

```
addr = pedersen_chain(
  ['STARKNET_CONTRACT_ADDRESS', anonymizer_address, salt,
   receiver_class_hash, ctor_hash], len=5
) mod (2^251 - 256)

ctor_hash = pedersen_chain([anonymizer_address], len=1)
```

`pedersen_chain` is the standard array-hash: `h_0 = 0; h_{i+1} = pedersen(h_i, x_i); final = pedersen(h_n, n)`. Pinned against `deploy_syscall(deploy_from_zero=false)` by `test_compute_address_matches_deploy_syscall` (the Day-1 gate).

### Entrypoint calldata layouts

All scalar (felt252 / ContractAddress / u128) — Serde-encodes one felt per arg.

**`privacy_invoke` (called by the pool inside Tx 1):**
```
[0] swap_id           : felt252       (user-generated, ≠ 0, unique per swap)
[1] asset_in          : ContractAddress
[2] in_amount         : u128
[3] asset_out         : ContractAddress
[4] note_id_out       : felt252       (compute_note_id of the output open note)
[5] refund_note_id    : felt252       (compute_note_id of the refund open note)
[6] deposit_address   : ContractAddress  (1Click depositAddress on Starknet)
[7] note_id_unused    : felt252       (SDK convention; ignored — pass 0)
```
Total: 8 felts.

**`finalize(swap_id)` / `recover(swap_id)`** (plain Starknet tx, any signer):
```
[0] swap_id : felt252
```
Total: 1 felt.

**`MailboxReceiver` constructor calldata** (used for off-chain mailbox
address derivation only — receiver instances are deployed by the
anonymizer, not by the SDK):
```
[0] anonymizer_address : ContractAddress
```

### CreateOpenNote requirements in Tx 1

The user must create both open notes with `depositor` set to the
anonymizer's address. Wrong depositor → the anonymizer's `privacy_invoke`
reverts at `OUT_NOTE_NOT_OURS` / `REFUND_NOTE_NOT_OURS` and Tx 1 rolls back
before any funds move. If `privacy_invoke`'s check is somehow bypassed,
the pool's own `deposit_to_open_note` rejects with `CALLER_NOT_DEPOSITOR`
during finalize/recover — defense in depth.

### Parity fixtures

`src/tests/test_sdk_parity.cairo` pins the salt domain constants,
calldata layouts, and per-swap salt derivation against a known
`FIXTURE_SWAP_ID`. The SDK should mirror these as off-chain test vectors
and assert byte-for-byte equality.

## Status lifecycle

```
None ── Tx 1 (privacy_invoke) ─→ Pending ─── finalize ──→ Finalized   (sticky)
                                          \
                                           recover  ──→ Recovered   (sticky)
```

Mutual exclusion enforced by the status flag and by `deploy_syscall`'s
revert-on-collision at the same mailbox address.

## Authorization

| Entrypoint | Caller restriction |
|---|---|
| `NearIntentsAnonymizer::privacy_invoke` | Strict: caller must be `privacy_address`. Storage exists; ungated calls could squat `swap_id` slots. |
| `NearIntentsAnonymizer::finalize` / `recover` | Permissionless. Output flows to the user-pre-registered open note. No abuse path. |
| `MailboxReceiver::sweep` | Strict: caller must be the anonymizer (baked in at construction). |

## Building

```bash
# from the workspace root, with mise + USC on PATH
PATH="$HOME/.cargo/bin:$PATH" mise exec -- scarb build -p near_intents_anonymizer
```

## Testing

Per-entrypoint unit tests + Day-1 address-derivation parity test against
`deploy_syscall`:
```bash
PATH="$HOME/.cargo/bin:$PATH" mise exec -- snforge test --package near_intents_anonymizer
# Expected: 40 passed (33 unit + 7 SDK parity fixtures)
```

End-to-end integration tests against the real privacy pool (full Tx 1 +
Tx 2 flow through `apply_actions`):
```bash
PATH="$HOME/.cargo/bin:$PATH" mise exec -- snforge test --package privacy test_near_intents_anonymizer
# Expected: 3 passed
```

## Sepolia deploy runbook

### Prerequisites

1. A privacy pool deployed on Sepolia with the
   `unfilled-open-note-support` feature (`Note.depositor` field, public
   `deposit_to_open_note` entrypoint). The pool's address goes into
   `PRIVACY_CONTRACT_ADDRESS`.
2. A funded Sepolia account: `ADMIN_ADDRESS` + `ADMIN_PRIVATE_KEY` set
   in `e2e/.env`. Needs STRK to pay declare + deploy fees (~0.01 STRK).
3. `STARKNET_RPC` pointing at any v0.10-compatible Sepolia RPC.
4. mise + cargo + the `unfilled-open-note-support` branch checked out
   (matches the privacy package version this was built against).

### Hash pre-flight (optional but recommended)

Compute the Sierra + CASM class hashes from the artifacts before
hitting the network. Lets the SDK dev hardcode `RECEIVER_CLASS_HASH`
immediately while the actual declare happens in parallel:

```bash
# 1. Build artifacts
PATH="$HOME/.cargo/bin:$PATH" mise exec -- scarb build -p near_intents_anonymizer

# 2. Compute class hashes off-chain (no network)
cd e2e
./node_modules/.bin/tsx scripts/precompute-near-intents-anonymizer-hashes.ts
```

Output looks like:

```
# MailboxReceiver
  Sierra class hash:    0x5231c55e8e9ba48278dea33e5fd593e5e3de3d75b14bdbfe7656b744cbb13b0
  Compiled class hash:  0x4a7faa6d5ea312e33be3c4deede066b357af3888455efa3998864003f5aeb96

# NearIntentsAnonymizer
  Sierra class hash:    0x512bc11a954bd58749a1b4402821d43868ffcf63f882030d39af7a1d8fb685b
  Compiled class hash:  0x3dd6fb07b5ecaa1f32ff8cbf7be8322f3c6df247a915c16e2a90e30107ef703
```

These will match what `account.declare(...)` computes on Sepolia for
the same artifacts.

### Live deploy

```bash
# Set in e2e/.env.deployed (or .env):
#   PRIVACY_CONTRACT_ADDRESS=0x…
#   STARKNET_RPC=https://…
#   ADMIN_ADDRESS=0x…
#   ADMIN_PRIVATE_KEY=0x…
# Optional: DEPLOY_SALT_SEED=0x…  (bump for a fresh instance)

cd e2e
npm run deploy-near-intents-anonymizer
```

The script:
1. Declares `MailboxReceiver` (skips if already declared at the same
   class hash).
2. Declares `NearIntentsAnonymizer` (same).
3. Deploys `NearIntentsAnonymizer(privacy_address, receiver_class_hash)`
   with a salt derived from `DEPLOY_SALT_SEED + 0xN1A`.
4. Appends class hashes + the anonymizer's address to
   `e2e/.env.deployed`.

The deploy is idempotent on declares; re-running with the same
`DEPLOY_SALT_SEED` and the same constructor args lands at the same
contract address (no-op). Bump the seed to deploy a fresh instance.

### Post-deploy sanity checks

Three quick on-chain checks before handing off to the SDK dev:

```bash
# 1. Anonymizer is wired to the right pool.
sncast --rpc-url $STARKNET_RPC call \
  --contract-address $NEAR_INTENTS_ANONYMIZER_ADDRESS \
  --function get_swap --calldata 0x0
# Should return PendingSwap { asset_in: 0, asset_out: 0, note_id_out: 0,
# refund_note_id: 0, status: SwapStatus::None }

# 2. Output mailbox derivation agrees with the off-chain formula.
sncast --rpc-url $STARKNET_RPC call \
  --contract-address $NEAR_INTENTS_ANONYMIZER_ADDRESS \
  --function output_mailbox --calldata 'FIXTURE_SWAP_1'
# Compare with the value the SDK's off-chain replica computes for the
# same swap_id + anonymizer_address + receiver_class_hash.

# 3. Refund mailbox differs from output for the same swap_id.
sncast --rpc-url $STARKNET_RPC call \
  --contract-address $NEAR_INTENTS_ANONYMIZER_ADDRESS \
  --function refund_mailbox --calldata 'FIXTURE_SWAP_1'
```

If (2) disagrees with the SDK's off-chain output, **stop and
investigate** — that's the silent failure mode that strands user funds
in inaccessible mailboxes. The parity test
(`test_compute_address_matches_deploy_syscall`) pins this against
`deploy_syscall` so disagreement means either the SDK formula has
drifted from `compute_address` in `near_intents_anonymizer.cairo`, or
the deployed receiver class hash isn't what the SDK is using.

### Hand-off to the SDK dev

After a successful deploy, hand the SDK dev:

| Field | Source |
|---|---|
| `ANONYMIZER_ADDRESS` | `e2e/.env.deployed` (`NEAR_INTENTS_ANONYMIZER_ADDRESS`) |
| `RECEIVER_CLASS_HASH` | Same file (`NEAR_INTENTS_RECEIVER_CLASS_HASH`) |
| Salt domains | This README, §"Salt-domain constants" |
| Mailbox address formula | This README, §"Mailbox-address derivation" |
| Calldata layouts | This README, §"Entrypoint calldata layouts" + `test_sdk_parity.cairo` |
| Parity fixture values | `test_sdk_parity.cairo` — run snforge once and copy the per-`FIXTURE_SWAP_ID` outputs |

The SDK dev's off-chain mailbox replica should produce the same address
as the on-chain `output_mailbox`/`refund_mailbox` views for any
`swap_id`. Verify with sanity check (2) above before any live swap.

## Future work (out of scope for hackathon)

- Hashed-only events (current events leak swap amounts; identity-privacy
  is preserved but observers learn that a swap of size X happened).
- Multi-mailbox chaining or batched finalize for additional unlinkability.
- A NEAR-side auto-submitter contract that does both legs in one user
  signature (would require POA signature verification in Cairo).
- AA session keys for single-signature UX across Tx 1 and Tx 2.
