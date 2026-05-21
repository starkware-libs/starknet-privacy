# Vesu Lending Anonymizer

Cairo smart contract for privacy-preserving deposit and withdraw operations on the [Vesu](https://vesu.xyz) lending protocol.

## Overview

`VesuLendingAnonymizer` is an invoke anonymizer contract called by the privacy pool contract via the `privacy_invoke` selector. It executes a Vesu lending operation on behalf of the privacy contract and returns a span of `OpenNoteDeposit` values for the privacy contract to apply.

Vesu uses ERC-4626 / SNIP-22 compatible tokenized vaults: depositing underlying assets mints share tokens (vTokens); withdrawing burns shares and returns underlying.

## Interface

### IVesuLendingAnonymizer

```
fn privacy_invoke(
    operation: LendingOperation,
    in_token: ContractAddress,
    out_token: ContractAddress,
    assets: u256,
    note_id: felt252,
) -> Span<OpenNoteDeposit>
```

| Parameter | Description |
|-----------|-------------|
| `operation` | `Deposit` or `Withdraw` |
| `in_token` | Input token address (underlying for deposit; vToken for withdraw) |
| `out_token` | Output token address (vToken for deposit; underlying for withdraw) |
| `assets` | Amount of assets to deposit or withdraw |
| `note_id` | Open note identifier to deposit output funds into |

Returns a single-element `Span<OpenNoteDeposit>` containing `(note_id, out_token, out_amount)`.

### IVToken

Subset of the Vesu vToken interface used internally: `deposit` and `withdraw`.

## Operations

**Deposit** (`in_token` → `out_token` vToken):
1. Approves the vToken contract to spend `assets` of `in_token`.
2. Calls `vToken.deposit(assets, self)` — vault pulls `in_token` from this contract.
3. Measures received vToken balance delta.
4. Approves the privacy contract to transfer the received vTokens.

**Withdraw** (`in_token` vToken → `out_token`):
1. Calls `vToken.withdraw(assets, self, self)` — burns shares from this contract, sends underlying here.
2. Measures received underlying balance delta.
3. Approves the privacy contract to transfer the received underlying.

## Errors

| Constant | Value | Condition |
|----------|-------|-----------|
| `ZERO_IN_TOKEN` | `'ZERO_IN_TOKEN'` | `in_token` is the zero address |
| `ZERO_OUT_TOKEN` | `'ZERO_OUT_TOKEN'` | `out_token` is the zero address |
| `ZERO_ASSETS` | `'ZERO_ASSETS'` | `assets` is zero |
| `TOKENS_EQUAL` | `'TOKENS_EQUAL'` | `in_token == out_token` |
| `RECEIVED_AMOUNT_OVERFLOW` | `'RECEIVED_AMOUNT_OVERFLOW'` | Received amount exceeds `u128::MAX` |
| `ZERO_OUT_AMOUNT` | `'ZERO_OUT_AMOUNT'` | Vault returned zero output tokens |

## Source modules

| File | Purpose |
|------|---------|
| [`vesu_lending_anonymizer.cairo`](src/vesu_lending_anonymizer.cairo) | `IVToken`, `IVesuLendingAnonymizer`, `LendingOperation`, `errors`, `VesuLendingAnonymizer` contract |

## Build and test

```bash
scarb build --package vesu_lending_anonymizer
scarb test   # wraps snforge test
```

snforge version: `0.59.0`

## Declare and deploy with sncast

[sncast](https://foundry-rs.github.io/starknet-foundry/) (Starknet Foundry) can declare and deploy the contract. Run from the **repository root** (workspace has multiple packages) and use an [account](https://foundry-rs.github.io/starknet-foundry/appendix/sncast/account.html) configured in `snfoundry.toml` or via `--account` / `--url`.

**1. Declare the contract**

```bash
scarb --profile release build
sncast --account <ACCOUNT_NAME> declare \
  --contract-name VesuLendingAnonymizer \
  --package vesu_lending_anonymizer \
  --network <mainnet|sepolia|devnet>
```

If you use a custom RPC instead of a preset network, use `--url <RPC_URL>` instead of `--network`. The command prints the **class hash**; use it for deploy.

**2. Deploy the contract**

The constructor takes no arguments.

```bash
sncast --account <ACCOUNT_NAME> deploy \
  --class-hash <CLASS_HASH_FROM_DECLARE> \
  --network <mainnet|sepolia|devnet>
```

## See also

- [Privacy pool contract](../privacy/README.md) — calls this contract via `InvokeExternal`
- [Project root](../../README.md) — architecture overview and prerequisites
