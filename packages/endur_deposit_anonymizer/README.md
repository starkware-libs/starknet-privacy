# Endur Deposit Anonymizer

Cairo smart contract for privacy-preserving deposits into [Endur](https://endur.fi) liquid staking vaults.

## Overview

`EndurDepositAnonymizer` is an invoke anonymizer contract called by the privacy pool contract via the `privacy_invoke` selector. It deposits underlying assets into an Endur ERC-4626 LST vault on behalf of the privacy contract and returns a span of `OpenNoteDeposit` values for the privacy contract to apply.

Endur vaults are ERC-4626 compatible: depositing underlying assets mints LST (liquid staking token) shares.

## Interface

### IEndurDepositAnonymizer

```
fn privacy_invoke(
    in_token: ContractAddress,
    out_token: ContractAddress,
    assets: u256,
    note_id: felt252,
) -> Span<OpenNoteDeposit>
```

| Parameter | Description |
|-----------|-------------|
| `in_token` | Underlying asset token address (e.g. STRK) |
| `out_token` | Endur LST vault address |
| `assets` | Amount of underlying assets to deposit |
| `note_id` | Open note identifier to deposit LST into |

Returns a single-element `Span<OpenNoteDeposit>` containing `(note_id, out_token, out_amount)`.

### IERC4626

Subset of the ERC-4626 interface used internally: `deposit`.

## Operation

**Deposit** (`in_token` underlying → `out_token` LST):
1. Approves the vault to spend `assets` of `in_token`.
2. Calls `vault.deposit(assets, self)` — vault pulls `in_token` from this contract.
3. Measures received LST balance delta.
4. Approves the privacy contract to transfer the received LST.

## Errors

| Constant | Value | Condition |
|----------|-------|-----------|
| `ZERO_IN_TOKEN` | `'ZERO_IN_TOKEN'` | `in_token` is the zero address |
| `ZERO_OUT_TOKEN` | `'ZERO_OUT_TOKEN'` | `out_token` is the zero address |
| `ZERO_ASSETS` | `'ZERO_ASSETS'` | `assets` is zero |
| `TOKENS_EQUAL` | `'TOKENS_EQUAL'` | `in_token == out_token` |
| `RECEIVED_AMOUNT_OVERFLOW` | `'RECEIVED_AMOUNT_OVERFLOW'` | Received amount exceeds `u128::MAX` |
| `ZERO_OUT_AMOUNT` | `'ZERO_OUT_AMOUNT'` | Vault returned zero LST shares |

## Source modules

| File | Purpose |
|------|---------|
| [`endur_deposit_anonymizer.cairo`](src/endur_deposit_anonymizer.cairo) | `IERC4626`, `IEndurDepositAnonymizer`, `errors`, `EndurDepositAnonymizer` contract |

## Build and test

```bash
scarb build --package endur_deposit_anonymizer
scarb test   # wraps snforge test
```

snforge version: `0.59.0`

## Declare and deploy with sncast

[sncast](https://foundry-rs.github.io/starknet-foundry/) (Starknet Foundry) can declare and deploy the contract. Run from the **repository root** (workspace has multiple packages) and use an [account](https://foundry-rs.github.io/starknet-foundry/appendix/sncast/account.html) configured in `snfoundry.toml` or via `--account` / `--url`.

**1. Declare the contract**

```bash
scarb --profile release build
sncast --account <ACCOUNT_NAME> declare \
  --contract-name EndurDepositAnonymizer \
  --package endur_deposit_anonymizer \
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
