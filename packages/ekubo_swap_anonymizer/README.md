# Ekubo Swap Anonymizer

Cairo smart contract for privacy-preserving single-hop swaps on the [Ekubo](https://ekubo.org) AMM.

## Overview

`EkuboSwapAnonymizer` is an invoke anonymizer contract called by the privacy pool contract via the `privacy_invoke` selector. It executes a single-hop Ekubo swap on behalf of the privacy contract and returns a span of `OpenNoteDeposit` values for the privacy contract to apply.

Full-swap-only: the anonymizer asserts no input tokens remain on the router after the swap (`sqrt_ratio_limit = 0`), so partial fills revert.

## Interface

### IEkuboSwapAnonymizer

```
fn privacy_invoke(
    router_addr: ContractAddress,
    token_amount: TokenAmount,
    pool_key: PoolKey,
    minimum_received: u256,
    skip_ahead: u128,
    note_id: felt252,
) -> Span<OpenNoteDeposit>
```

| Parameter          | Description                                                                                         |
|--------------------|-----------------------------------------------------------------------------------------------------|
| `router_addr`      | Ekubo Router contract address                                                                       |
| `token_amount`     | Input token + amount (Ekubo `TokenAmount`; amount must be positive)                                 |
| `pool_key`         | Ekubo pool key (`token0`, `token1`, `fee`, `tick_spacing`, `extension`). Output token is the other. |
| `minimum_received` | Slippage protection — minimum output amount passed to `clear_minimum`                               |
| `skip_ahead`       | Ekubo route optimization parameter                                                                  |
| `note_id`          | Open note identifier to deposit the output into                                                     |

Returns a single-element `Span<OpenNoteDeposit>` containing `(note_id, out_token, out_amount)`.

## Errors

| Constant                  | Condition                                                                  |
|---------------------------|----------------------------------------------------------------------------|
| `ZERO_ROUTER`             | `router_addr` is zero                                                      |
| `ZERO_IN_TOKEN`           | `token_amount.token` is zero                                               |
| `NEGATIVE_AMOUNT`         | `token_amount.amount` is negative                                          |
| `ZERO_IN_AMOUNT`          | `token_amount.amount` is zero                                              |
| `TOKEN_MISMATCH_POOL_KEY` | `token_amount.token` is neither `pool_key.token0` nor `pool_key.token1`    |
| `IN_TOKEN_NOT_CLEARED`    | Input-token balance on the router is non-zero after the swap (partial fill)|
| `RECEIVED_AMOUNT_OVERFLOW`| Received output amount overflows `u128`                                    |
| `ZERO_OUT_AMOUNT`         | Swap produced zero output tokens                                           |

## Source modules

| File                                                            | Purpose                                                           |
|-----------------------------------------------------------------|-------------------------------------------------------------------|
| [`ekubo_swap_anonymizer.cairo`](src/ekubo_swap_anonymizer.cairo)        | `IEkuboSwapAnonymizer`, `errors`, `EkuboSwapAnonymizer` contract          |

## Build and test

```bash
scarb build --package ekubo_swap_anonymizer
scarb test   # wraps snforge test
```

## Declare and deploy with sncast

[sncast](https://foundry-rs.github.io/starknet-foundry/) (Starknet Foundry) can declare and deploy the contract. Run from the **repository root** (the workspace has multiple packages) and use an [account](https://foundry-rs.github.io/starknet-foundry/appendix/sncast/account.html) configured in `snfoundry.toml` or via `--account` / `--url`.

**1. Declare the contract**

```bash
scarb --profile release build
sncast --account <ACCOUNT_NAME> declare \
  --contract-name EkuboSwapAnonymizer \
  --package ekubo_swap_anonymizer \
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
- [Vesu Lending Anonymizer](../vesu_lending_anonymizer/README.md) — sibling anonymizer for lending operations
- [Project root](../../README.md) — architecture overview and prerequisites
