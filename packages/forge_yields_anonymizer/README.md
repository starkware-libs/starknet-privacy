# ForgeYields Anonymizer

Cairo smart contract for privacy-preserving deposits into [ForgeYields](https://app.forgeyields.com) strategies via the Starknet Privacy Pool.

## Overview

`ForgeYieldsAnonymizer` is an **invoke anonymizer** called by the privacy pool contract via the `privacy_invoke` selector. It executes a ForgeYields gateway deposit on behalf of the pool and returns a `Span<OpenNoteDeposit>` describing the resulting share note for the pool to apply.

ForgeYields' [`TokenGateway`](https://github.com/your-org/forge-contracts-cvm/blob/main/packages/token_gateway/src/token_gateway/interface.cairo) is ERC-4626 / SNIP-22 compatible — the gateway is itself the share ERC-20, so depositing underlying mints shares on the same address.

## Scope

This v1 supports **`Deposit` only**.

ForgeYields redemptions are **epoch-delayed and NFT-based** (`request_redeem` → `claim_redeem` after the controller reports back), which does not complete in a single private transaction and requires additional privacy-pool support (ERC-721-style notes or an opaque two-step flow) to be anonymized end-to-end. Until that's available, users redeem by un-shielding their shares first.

## Interface

```cairo
fn privacy_invoke(
    operation: ForgeOperation,        // Deposit (only variant for now)
    in_token: ContractAddress,        // Underlying (USDC, ETH, …)
    out_token: ContractAddress,       // ForgeYields gateway / share token
    assets: u256,                     // Amount of underlying
    note_id: felt252,                 // Open note to deposit shares into
) -> Span<OpenNoteDeposit>
```

Returns a single-element `Span<OpenNoteDeposit>` of `(note_id, out_token, out_amount)`.

## Flow

**Deposit** (`in_token` underlying → `out_token` shares):

1. Approve the gateway to spend `assets` of `in_token`.
2. Call `gateway.deposit(assets, self)` — gateway pulls underlying, mints shares back.
3. Measure share-balance delta on the gateway (gateway = share ERC-20).
4. Approve the privacy contract to transfer the received shares.
5. Return `(note_id, out_token, out_amount)`.

## Errors

| Constant | Value | Condition |
|----------|-------|-----------|
| `ZERO_IN_TOKEN` | `'ZERO_IN_TOKEN'` | `in_token` is the zero address |
| `ZERO_OUT_TOKEN` | `'ZERO_OUT_TOKEN'` | `out_token` is the zero address |
| `ZERO_ASSETS` | `'ZERO_ASSETS'` | `assets` is zero |
| `TOKENS_EQUAL` | `'TOKENS_EQUAL'` | `in_token == out_token` |
| `RECEIVED_AMOUNT_OVERFLOW` | `'RECEIVED_AMOUNT_OVERFLOW'` | Received amount exceeds `u128::MAX` |
| `ZERO_OUT_AMOUNT` | `'ZERO_OUT_AMOUNT'` | Gateway returned zero shares |

## Source modules

| File | Purpose |
|------|---------|
| [`forge_yields_anonymizer.cairo`](src/forge_yields_anonymizer.cairo) | `IForgeTokenGateway`, `IForgeYieldsAnonymizer`, `ForgeOperation`, `errors`, `ForgeYieldsAnonymizer` contract |

## Build and test

```bash
scarb build --package forge_yields_anonymizer
scarb test
```

snforge version: `0.59.0`

## Declare and deploy with sncast

Run from the **repository root** (workspace has multiple packages).

**1. Declare**

```bash
scarb --profile release build
sncast --account <ACCOUNT_NAME> declare \
  --contract-name ForgeYieldsAnonymizer \
  --package forge_yields_anonymizer \
  --network <mainnet|sepolia|devnet>
```

**2. Deploy** (no constructor arguments):

```bash
sncast --account <ACCOUNT_NAME> deploy \
  --class-hash <CLASS_HASH_FROM_DECLARE> \
  --network <mainnet|sepolia|devnet>
```

## See also

- [Privacy pool contract](../privacy/README.md) — calls this contract via `InvokeExternal`
- [Vesu lending anonymizer](../vesu_lending_anonymizer/README.md) — the template this contract is modeled on
- [Project root](../../README.md) — architecture overview and prerequisites
