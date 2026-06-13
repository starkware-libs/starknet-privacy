# Hunter 15 Findings: vesu_lending_anonymizer.cairo

**File:** `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo`

---

## Bug 1 (CONFIRMED — CRITICAL): Deposit operation relies on undocumented pre-funding by the caller

### Description

The `privacy_invoke` Deposit path calls `vToken.deposit(assets, receiver: self_addr)`, which internally calls `transfer_from(sender: get_caller_address(), ...)` — i.e., pulls `in_token` from the anonymizer contract. This requires the anonymizer to hold `in_token` **before** `privacy_invoke` is called.

The anonymizer itself has no `receive` function, no funding path inside `privacy_invoke`, and stores no funds between invocations. The privacy contract's `_apply_invoke` simply calls the anonymizer via `call_contract_syscall` and does not send tokens to it first.

How the anonymizer gets funded in the intended use case is **not encoded in the contract logic**. Inspecting the test (`test_vesu_lending_anonymizer.cairo`, line 22–23):

```cairo
vesu.underlying_token.supply(address: vesu.lending_anonymizer, amount: preexisting_balance + amount);
```

The test pre-funds the anonymizer directly via a token mint. In production this would require the caller to have done a `TransferTo(anonymizer_addr, in_token, assets)` server action **before** the `Invoke` action in the same transaction. However:

1. The `InvokeExternalInput` in the privacy contract carries no `token`/`amount` metadata — it is simply `{ contract_address, calldata }`.
2. There is no enforced coupling between a preceding `TransferTo` and the subsequent `Invoke`. A user could call `InvokeExternal` without first arranging the transfer, causing the `vToken.deposit` to revert with `ERC20: insufficient balance`.
3. There is no check inside `privacy_invoke` that the anonymizer's `in_token` balance is at least `assets` before attempting the operation, though such a check would only catch the symptom rather than the root cause.

**Root cause:** The contract's design assumes that the caller pre-funds it (via the privacy contract's `TransferTo` action), but this precondition is not enforced anywhere in the anonymizer. The preconditions documented in the `IVesuLendingAnonymizer` interface say "The contract must have sufficient input token balance" but nothing enforces this or tells the privacy contract to send the tokens.

### Impact

Any user who submits a `ClientAction::InvokeExternal` targeting the anonymizer without also including a matching `TransferTo(anonymizer, in_token, assets)` in the same transaction will get a revert. This is a usability hazard, but since it only causes self-inflicted reverts, it is not directly exploitable to steal funds. It is however a protocol design gap: the anonymizer silently depends on out-of-band state.

---

## Bug 2 (CONFIRMED — CRITICAL): Same issue for Withdraw — vTokens must pre-exist on the anonymizer

### Description

The Withdraw path calls `IVTokenDispatcher { contract_address: in_token }.withdraw(assets, receiver: self_addr, owner: self_addr)`. The MockVesuVault implementation (line 64) calls `self.erc20.burn(account: owner, ...)`, which burns vTokens from `self_addr` (the anonymizer). So the anonymizer must already hold vToken shares before `privacy_invoke` is called.

The same funding gap applies: the anonymizer has no balance between calls and must be pre-funded by a `TransferTo(anonymizer, vToken, assets)` executed earlier in the same transaction. There is no enforcement of this.

The test confirms this by pre-running `privacy_invoke_deposit` before `privacy_invoke_withdraw` in the same test (line 31 then 48), but the deposit leaves vTokens on the anonymizer (`vault_balance_of(lending_anonymizer) == amount`, line 45).

### Impact

Same as Bug 1.

---

## Bug 3 (INFORMATIONAL): `out_amount` truncated to `u128` — overflow error is correct but limiting

### Description

```cairo
let out_amount: u128 = (balance_after - balance_before)
    .try_into()
    .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
```

The `assets` parameter is `u256` but the measured received amount is cast to `u128`. If a vault legitimately returns more than `u128::MAX` tokens (e.g., a token with very low unit value and large supply), this will panic with `RECEIVED_AMOUNT_OVERFLOW`.

The test `test_privacy_invoke_overflow` (using `MockVesuVaultOverflow`) explicitly tests this and confirms the revert.

**Assessment:** This is a known limitation, tested, and the error message is accurate. For realistic ERC-20 tokens following StarkNet/EVM conventions (max supply `u128::MAX` or `2^128 - 1`), this cannot be triggered. It becomes relevant only for tokens with total supply exceeding `u128::MAX`, which is atypical but not impossible on StarkNet where u256 token balances are standard. **Low severity** — the guard is correct, but the `u128` ceiling on `out_amount` is architecturally limiting and undocumented in external-facing docs.

---

## Bug 4 (NOT A BUG): `balance_before` measured before both operations

### Description

Reviewed. For both Deposit and Withdraw, `balance_before` captures the `out_token` balance, the operation runs, and `balance_after` captures it again. The delta is the received amount. This is correct for both operations:

- **Deposit:** `out_token = vToken`. After `vToken.deposit`, vTokens are minted to `self_addr`. Delta = minted shares. Correct.
- **Withdraw:** `out_token = underlying`. After `vToken.withdraw`, underlying is sent to `self_addr`. Delta = received underlying. Correct.

No issue.

---

## Bug 5 (CONFIRMED — LOW): Withdraw does not call `approve` before `vToken.withdraw`; relies on `owner == msg.sender` convention

### Description

```cairo
LendingOperation::Withdraw => {
    IVTokenDispatcher { contract_address: in_token }
        .withdraw(:assets, receiver: self_addr, owner: self_addr)
},
```

ERC-4626 specifies that `withdraw(assets, receiver, owner)` where `owner == msg.sender` does NOT require prior approval (the caller is spending their own shares). The MockVesuVault confirms this: it directly burns from `owner` without checking allowance (line 64).

**However:** If the real Vesu `vToken.withdraw` implementation deviates from the ERC-4626 convention and requires an allowance even when `owner == msg.sender`, the call would fail. The anonymizer makes no approval before calling `withdraw`. This is a trust assumption about Vesu's implementation.

Given Vesu documentation states ERC-4626 / SNIP-22 compliance and this is standard behavior, the risk is low. But it should be noted as an integration assumption.

---

## Bug 6 (CONFIRMED — MEDIUM): `balance_after - balance_before` can underflow if reentrancy reduces `out_token` balance

### Description

```cairo
let balance_before = out_erc20.balance_of(account: self_addr);
// ... operation ...
let balance_after = out_erc20.balance_of(account: self_addr);
let out_amount: u128 = (balance_after - balance_before).try_into()...
```

If a malicious `out_token` (or `in_token` in Deposit mode, since it could be the vToken in disguise) performs a reentrancy attack that reduces the anonymizer's `out_token` balance during execution, `balance_after < balance_before` is possible. In Cairo's `u256` arithmetic, this would cause an **unsigned underflow panic** (the subtraction would underflow), not produce a large u256. This would manifest as a hard revert, not as a wrong-value approval.

The more subtle case: If a reentrant call causes the anonymizer's `out_token` balance to increase by more than `u128::MAX`, the `try_into()` overflow check catches it. If the balance decreases, the subtraction itself panics before reaching `try_into()`.

**Assessment:** No funds can be stolen via this path (all reverts). But a malicious `out_token` could use reentrancy to make the anonymizer's `privacy_invoke` always revert (griefing). Since the anonymizer is stateless and has no reentrancy guard, this is a moderate reliability concern.

---

## Bug 7 (CONFIRMED — LOW): No upper bound check on `assets` parameter

### Description

The `assets: u256` parameter is not bounded. A caller can pass `assets = u256::MAX`. This leads to:

- **Deposit:** `in_erc20.approve(spender: out_token, amount: u256::MAX)`. This succeeds (approve doesn't check balance). Then `vToken.deposit(u256::MAX, ...)` will call `transfer_from(sender: self_addr, amount: u256::MAX)`, which will fail with `ERC20: insufficient balance` unless the anonymizer actually holds that many tokens.
- **Withdraw:** `vToken.withdraw(u256::MAX, ...)` will attempt to burn `u256::MAX` shares from the anonymizer, which will fail with `ERC20: insufficient balance`.

Both cases revert cleanly — no fund loss. This is only a self-inflicted revert with no security impact. However, the infinite approval set on `in_token` toward `out_token` (the vault) persists even after revert... actually no: in Cairo/StarkNet, if the transaction reverts, all storage writes (including the approve) are rolled back. So no issue.

**Assessment:** Informational. Clean revert, no state corruption.

---

## Summary Table

| # | Title | Severity | Status |
|---|-------|----------|--------|
| 1 | Deposit: anonymizer requires pre-funding with `in_token` — not enforced | Critical (design gap) | Confirmed |
| 2 | Withdraw: anonymizer requires pre-funding with vTokens — not enforced | Critical (design gap) | Confirmed |
| 3 | `out_amount` cast to `u128` — overflow on large yields | Low | Confirmed (tested, known) |
| 4 | `balance_before` measurement timing | — | Not a bug |
| 5 | Withdraw: no `approve` before `vToken.withdraw` — assumes ERC-4626 convention | Low | Confirmed (integration assumption) |
| 6 | `balance_after - balance_before` can panic on reentrancy reducing balance | Medium | Confirmed (griefing via malicious token) |
| 7 | `assets = u256::MAX` causes clean revert, no state corruption | Informational | Confirmed |

---

## Key Observation on Bugs 1 & 2

The intended use pattern (inferred from tests) is:
1. User holds a privacy note for `in_token`.
2. Transaction includes `UseNote(in_token)` → credits `in_token` to `token_balances`.
3. Transaction includes a virtual `TransferTo(anonymizer_addr, in_token, assets)` to physically send tokens from the privacy contract to the anonymizer.
4. Transaction includes `InvokeExternal(anonymizer_addr, calldata)` → the anonymizer now holds `in_token` and can proceed.

However, there is no `ServerAction::TransferTo` initiated by `InvokeExternal` — the user must separately include a `Withdraw` or another mechanism that triggers `TransferTo`. The privacy contract's `token_balances` mechanism tracks virtual balances but only enforces that the sum is zero at the end; it does not enforce that the anonymizer is funded before the Invoke action runs.

The actual ordering of `_apply_actions` processes actions in iteration order. If the user constructs actions in the order `[TransferTo(anonymizer), Invoke(anonymizer)]`, the funding happens before the invoke. But the privacy contract never generates `TransferTo(anonymizer)` from `InvokeExternal` — it generates only `Invoke`. A separate `Withdraw` action pointing `to_addr = anonymizer` would produce `TransferTo(anonymizer)`, but `Withdraw` requires `to_addr` to be the user's address (it must match some precondition — this needs verification). The design of how users are supposed to fund the anonymizer is architecturally underspecified.
