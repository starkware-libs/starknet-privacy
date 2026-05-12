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

## Deploying

Once a privacy pool with the `unfilled-open-note-support` feature is
deployed:

```bash
# Build the package
PATH="$HOME/.cargo/bin:$PATH" mise exec -- scarb build -p near_intents_anonymizer

# Set in e2e/.env (or e2e/.env.deployed):
# PRIVACY_CONTRACT_ADDRESS=0x…   ← the pool you're targeting

cd e2e
npm run deploy-near-intents-anonymizer
```

Class hashes + the anonymizer's address get appended to
`e2e/.env.deployed`. The deploy is idempotent — re-running with the same
`DEPLOY_SALT_SEED` lands at the same address; bump the seed to deploy a
fresh instance.

## Future work (out of scope for hackathon)

- Hashed-only events (current events leak swap amounts; identity-privacy
  is preserved but observers learn that a swap of size X happened).
- Multi-mailbox chaining or batched finalize for additional unlinkability.
- A NEAR-side auto-submitter contract that does both legs in one user
  signature (would require POA signature verification in Cairo).
- AA session keys for single-signature UX across Tx 1 and Tx 2.
