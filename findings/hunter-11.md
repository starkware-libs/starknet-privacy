# Hunter 11 Findings: Vesu Lending Anonymizer — Deposit Path

**File:** `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo`

---

## Summary

After a full read of the anonymizer, the privacy contract (`privacy.cairo`), and all test files, I found **one real logic bug** and **one confirmed non-issue** worth documenting with reasoning.

---

## BUG-1: Residual `in_token` approval after deposit is never cleared

**Severity:** Low / griefing surface

**Location:** `privacy_invoke`, `LendingOperation::Deposit` branch

```cairo
// Deposit branch:
in_erc20.approve(spender: out_token, amount: assets);
IVTokenDispatcher { contract_address: out_token }
    .deposit(:assets, receiver: self_addr)
```

**Root cause:**

`approve` sets an allowance of exactly `assets` for the vToken contract (`out_token`) to spend the anonymizer's `in_token`. The ERC-20 `approve` call is a *set*, not an *increment* — it replaces any existing allowance.

The `deposit` call on the Vesu vToken is expected to consume exactly `assets` of underlying, pulling them via `transferFrom(anonymizer, vault, assets)`. In the normal case (1:1 or fixed-rate vault), the full allowance is consumed and the residual is zero.

However, **ERC-4626 vaults are not required to pull exactly `assets`**. A vault implementation might:
1. Round down due to decimal precision, pulling `assets - 1` and leaving a 1-wei allowance.
2. Implement deposit fees, pulling `assets - fee` and leaving a `fee`-sized residual allowance.
3. Be a non-standard vault that pulls a different amount entirely.

In any such case, after `privacy_invoke` returns, the anonymizer has a **non-zero residual allowance** from `in_token` to `out_token` (the vToken contract). This allowance is **never reset to zero**. 

**Impact path:**

The vToken contract could exploit the residual allowance in a subsequent call to `transferFrom(anonymizer, attacker, residual)`. While this requires the vToken itself to be malicious or buggy (and the privacy protocol requires `out_token` to be a trusted Vesu vault), the anonymizer accumulates these residual allowances across calls and never clears them. Over many deposits, residual approvals could compound if vault behavior changes or if a vault upgrade introduces fee logic.

**Correct pattern:** After the deposit call, reset the allowance to zero:

```cairo
in_erc20.approve(spender: out_token, amount: assets);
IVTokenDispatcher { contract_address: out_token }
    .deposit(:assets, receiver: self_addr);
// Reset residual approval.
in_erc20.approve(spender: out_token, amount: 0);
```

**Current test coverage gap:** The test suite (`test_vesu_lending_anonymizer.cairo`) uses `MockVesuVault` which always pulls exactly `assets` (1:1 ratio). No test verifies the residual-approval scenario with a vault that pulls a different amount.

---

## BUG-2: Stranded `in_token` balance when `assets < balance_of(anonymizer, in_token)`

**Severity:** Medium — funds permanently lost

**Location:** `privacy_invoke`, called from privacy contract's `_apply_invoke`

**Setup:**

The full invocation flow is:
1. Privacy contract `_apply_actions` processes a `ServerAction::TransferTo(to_addr: anonymizer, token: in_token, amount: X)` — this transfers `X` of `in_token` from the privacy contract to the anonymizer.
2. Privacy contract `_apply_actions` then processes `ServerAction::Invoke(anonymizer, calldata)` — this calls `privacy_invoke(Deposit, in_token, out_token, assets: Y, note_id)`.

**The bug:**

There is no on-chain enforcement that `Y == X`. The `assets` parameter in `privacy_invoke` is caller-supplied in the `calldata` of the `Invoke` action. If `Y < X`, the deposit will only consume `Y` of `in_token`. The remaining `X - Y` of `in_token` stays in the anonymizer contract indefinitely.

**Why the funds are unrecoverable:**

The anonymizer contract has:
- No `sweep`/`rescue` function to recover stranded tokens
- No `withdraw` path for the underlying `in_token` (the Withdraw operation burns vTokens and gets `in_token` back from the vault, but cannot reclaim tokens already sitting in the anonymizer without first depositing them)
- No owner or admin role

The privacy contract's `_apply_transfer_to` (which sends tokens to the anonymizer before the invoke) is:

```cairo
fn _apply_transfer_to(ref self: ContractState, input: TransferToInput) {
    let TransferToInput { to_addr, token, amount } = input;
    // Note: This function should NOT panic as the contract should have the balance.
    checked_transfer(token_address: token, recipient: to_addr, amount: amount.into());
}
```

And the privacy contract's balance tracking (`token_balances`) only verifies that the client-declared `amount` in `Withdraw` matches what was previously credited via `UseNote`/`Deposit`. It does not verify that the anonymizer actually consumed the full transferred amount. The balance check is:

```cairo
token_balances.squash().assert_valid();  // all balances must be zero at end
```

This is satisfied as long as every `Withdraw` (which calls `TransferTo`) has a matching `UseNote`/`Deposit` credit. The `Invoke` action is phase 7 and does not interact with `token_balances` at all — the privacy contract does not track or verify that the anonymizer spent all received tokens.

**Concrete attack / accidental scenario:**

A user constructs a transaction with:
- `UseNote` consuming a note for 1000 USDC (credits `token_balances[USDC] += 1000`)
- `Withdraw(to_addr: anonymizer, token: USDC, amount: 1000)` (debits `token_balances[USDC] -= 1000`)
- `CreateOpenNote(token: vUSDC, ...)` 
- `InvokeExternal(anonymizer, calldata_with_assets=500)`

The privacy contract will:
1. Transfer 1000 USDC to the anonymizer
2. Call `privacy_invoke(Deposit, USDC, vUSDC, 500, note_id)`
3. Anonymizer deposits 500 USDC → mints 500 vUSDC → returns `OpenNoteDeposit { token: vUSDC, amount: 500 }`
4. Privacy contract pulls 500 vUSDC from anonymizer → deposits into open note

Result: 500 USDC are stranded in the anonymizer. The open note contains 500 vUSDC, not 1000. The user effectively loses half their funds with no recovery path.

**Off-chain mitigation:** The privacy protocol relies on off-chain proof/server infrastructure to construct valid `actions` sequences. A correctly implemented client/server will always set `assets == amount`. However, there is no *on-chain* enforcement of this invariant.

**Recommended fix:** Add an assertion in `privacy_invoke` that after the deposit, the anonymizer's `in_token` balance is zero (or verify that `assets` equals the anonymizer's `in_token` balance before the operation):

```cairo
// Before deposit:
let in_balance = in_erc20.balance_of(account: self_addr);
assert(in_balance == assets, 'ASSETS_BALANCE_MISMATCH');
```

Alternatively, use the full balance rather than the caller-supplied `assets`:

```cairo
let assets = in_erc20.balance_of(account: self_addr);
assert(assets.is_non_zero(), ZERO_ASSETS);
in_erc20.approve(spender: out_token, amount: assets);
IVTokenDispatcher { contract_address: out_token }
    .deposit(:assets, receiver: self_addr)
```

This makes the deposit atomic with respect to the anonymizer's balance — no stranding is possible.

---

## Non-Issue: `balance_before` / `balance_after` delta correctly handles pre-existing balance

The code measures `out_erc20.balance_of(self_addr)` before and after the operation, so pre-existing vToken balances do not inflate `out_amount`. This is correct and intentional.

## Non-Issue: `out_amount.into()` type conversion

`out_amount: u128` converted to `u256` via `.into()` for the `approve` call is correct. Cairo's `u128::into::<u256>()` sets `high = 0, low = out_amount`, which is a valid u256.

## Non-Issue: Return value of `deposit` ignored

The minted shares count returned by `deposit(...)` is dropped. The actual received vToken amount is computed via the balance delta. This is correct — the balance delta is authoritative and independent of vault accounting rounding.

---

## Test Coverage Gaps

1. **No test for `assets < anonymizer_balance` scenario** (BUG-2). The existing test `test_privacy_invoke_deposit_withdraw` always sets `assets == balance` via:
   ```cairo
   vesu.underlying_token.supply(address: vesu.lending_anonymizer, amount: preexisting_balance + amount);
   // then:
   vesu.privacy_invoke_deposit(:amount, :note_id);  // assets == amount == supplied
   ```
   A test with `supply(anonymizer, 1000)` followed by `privacy_invoke_deposit(500)` would expose the stranded 500.

2. **No test for residual approval** (BUG-1). No mock vault that pulls `assets - 1` exists to test this path.
