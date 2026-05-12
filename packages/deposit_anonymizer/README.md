# Deposit Anonymizer

Cairo contract used as a privacy-pool `privacy_invoke` target that mediates a SNIP-9-authorized account deposit into a privacy-pool open note.

## Overview

`DepositAnonymizer` implements the protocol's `privacy_invoke(calls) -> Span<OpenNoteDeposit>` interface and exposes a second entrypoint, `deposit_to_open_note(note_id, token, amount)`, which is called *inside* a user-signed SNIP-9 outside execution. The two entrypoints are designed to work together so the deposit's `note_id` is committed to by the user's SNIP-9 signature, defeating front-running where an attacker captures the signed outside execution and redirects the deposit to a different note.

The privacy pool's `InvokeExternal` action calls a single contract at the hardcoded `privacy_invoke` selector and feeds its `Span<OpenNoteDeposit>` return back into the pool's `_apply_invoke`. Plain Starknet accounts implement neither that selector nor the `OpenNoteDeposit` return contract, so flows that need user-signed pre-conditions on `apply_actions` (ephemeral-account SNIP-9 deposits, transferFrom-based pulls, etc.) need a small intermediary that's both reachable by the pool and capable of dispatching arbitrary calls. This contract is that intermediary.

## Interface

```cairo
fn privacy_invoke(calls: Array<Call>) -> Span<OpenNoteDeposit>
fn deposit_to_open_note(note_id: felt252, token: ContractAddress, amount: u128) -> OpenNoteDeposit
```

### `privacy_invoke`

Dispatches each `Call` in order via `call_contract_syscall`. The **last** call must be `A.execute_from_outside_v2(...)`; its return is parsed as the `Array<Span<felt252>>` produced by OZ's SRC9_V2 (one `Span` per inner call), and the **last** inner `Span` is deserialized as `OpenNoteDeposit` (the return of `deposit_to_open_note`). The anonymizer then approves the pool (`get_caller_address()`) for the deposit amount on the deposit token, and returns `[deposit].span()` for the pool to fill the note.

### `deposit_to_open_note`

Called *inside* A's SNIP-9 outside execution (caller = A). Pulls `amount` of `token` from the caller via `transferFrom` (A must have pre-approved this contract for `amount` via a preceding inner call). Returns `OpenNoteDeposit { note_id, token, amount }`.

## Why this shape

The `note_id` is part of the inner `deposit_to_open_note` call's calldata, so the user's SNIP-9 signature commits to it. A front-runner that captures the signed outside execution cannot redirect the deposit to a different note: substituting `note_id` invalidates the signature, and re-using the original payload simply fills the originally-signed note.

There is no contract storage — the deposit info flows through return values only.

## Source modules

| File | Purpose |
|------|---------|
| [`deposit_anonymizer.cairo`](src/deposit_anonymizer.cairo) | `IDepositAnonymizer`, `DepositAnonymizer` contract |

## Build and test

```bash
scarb build --package deposit_anonymizer
scarb test   # wraps snforge test
```

snforge version: `0.59.0`

## Declare and deploy with sncast

Run from the **repository root**.

```bash
scarb --profile release build
sncast --account <ACCOUNT_NAME> declare \
  --contract-name DepositAnonymizer \
  --package deposit_anonymizer \
  --network <mainnet|sepolia|devnet>

sncast --account <ACCOUNT_NAME> deploy \
  --class-hash <CLASS_HASH_FROM_DECLARE> \
  --network <mainnet|sepolia|devnet>
```

The constructor takes no arguments.

## See also

- [Privacy pool contract](../privacy/README.md) — calls this contract via `InvokeExternal`
- [Project root](../../README.md) — architecture overview and prerequisites
