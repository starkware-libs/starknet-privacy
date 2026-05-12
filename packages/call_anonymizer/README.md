# Call Anonymizer

Minimal Cairo contract used as a privacy-pool `privacy_invoke` target that simply dispatches an array of arbitrary `Call`s on behalf of the pool.

## Overview

`CallAnonymizer` implements the protocol's `privacy_invoke(calls: Array<Call>) -> Span<OpenNoteDeposit>` interface and does exactly one thing: it executes each `Call` in order via `call_contract_syscall`, then returns an empty `Span<OpenNoteDeposit>`.

The privacy pool's `InvokeExternal` action calls a single contract at the hardcoded `privacy_invoke` selector and expects an `OpenNoteDeposit` return contract. Plain Starknet accounts implement neither, so flows that need user-signed pre-conditions on `apply_actions` (ephemeral-account SNIP-9 deposits, transferFrom-based pulls, etc.) need a small intermediary that's both reachable by the pool and capable of dispatching arbitrary calls. This contract is that intermediary.

## Interface

```cairo
fn privacy_invoke(calls: Array<Call>) -> Span<OpenNoteDeposit>
```

| Parameter | Description |
|-----------|-------------|
| `calls`   | Calls to dispatch via `call_contract_syscall`, in order. `get_caller_address()` inside each dispatched call is this contract's address. |

Returns an empty `Span<OpenNoteDeposit>` so the pool's `_apply_invoke` runs no fills of its own. Any open-note fills must be reached through the dispatched calls themselves (e.g. a `pool.deposit_to_open_note(...)` reached inside a SNIP-9 `execute_from_outside_v2`).

## Notes for reviewers

This dispatcher does not perform a balance-delta check. Flows are expected to fully consume any funds inside the dispatched calls; protocol-level checks at downstream contracts (e.g. `pool.deposit_to_open_note`'s own `transferFrom` reverting on under-funding) catch mis-amounts at the right layer. If a future flow needs to *transit* funds through this contract rather than pass them straight to a destination, a per-token balance assert may be worth adding.

## Source modules

| File | Purpose |
|------|---------|
| [`call_anonymizer.cairo`](src/call_anonymizer.cairo) | `ICallAnonymizer`, `CallAnonymizer` contract |

## Build and test

```bash
scarb build --package call_anonymizer
scarb test   # wraps snforge test
```

snforge version: `0.59.0`

## Declare and deploy with sncast

Run from the **repository root**.

```bash
scarb --profile release build
sncast --account <ACCOUNT_NAME> declare \
  --contract-name CallAnonymizer \
  --package call_anonymizer \
  --network <mainnet|sepolia|devnet>

sncast --account <ACCOUNT_NAME> deploy \
  --class-hash <CLASS_HASH_FROM_DECLARE> \
  --network <mainnet|sepolia|devnet>
```

The constructor takes no arguments.

## See also

- [Privacy pool contract](../privacy/README.md) — calls this contract via `InvokeExternal`
- [Project root](../../README.md) — architecture overview and prerequisites
