# Bug Hunter 13 — Cross-Contract Token Flow Analysis

## Scope

Files analyzed:
- `packages/privacy/src/privacy.cairo` lines 800–975 (`_apply_actions`, `_apply_invoke`, `_deposit_to_open_note`)
- `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo` (full)
- `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo` (full)
- `packages/ekubo_swap_anonymizer/src/test_utils_contracts/mock_ekubo_amm.cairo`
- `packages/vesu_lending_anonymizer/src/test_utils_contracts/mock_vesu_vault.cairo`
- `packages/privacy/src/tests/test_ekubo_swap_anonymizer.cairo`
- `packages/privacy/src/actions.cairo`
- `packages/privacy/src/objects.cairo`

---

## Finding 1 (HIGH): Stranded vTokens in Vesu Anonymizer Enable Cross-User Theft of Underlying

**File:** `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo:157-161`

**Severity:** High — a user can steal other users' stranded vToken shares by calibrating the `assets` withdrawal parameter.

### Background

The Vesu anonymizer's Withdraw path calls:
```cairo
IVTokenDispatcher { contract_address: in_token }
    .withdraw(:assets, receiver: self_addr, owner: self_addr)
```

`assets` is the amount of **underlying** to withdraw. The ERC-4626 `withdraw(assets, receiver, owner)` burns the number of shares required to produce `assets` of underlying from `owner`'s balance. In a vault with a share price greater than 1 (i.e., 1 share redeems more than 1 underlying due to interest accrual), this burns **fewer shares** than were sent to the anonymizer.

The anonymizer itself is permissionless (no owner, no admin, no storage of per-user balances). Its vToken balance is a single global pool.

### Stranding mechanism

User A:
1. Sends `shares_A` vToken to the anonymizer via `Withdraw { to_addr: anonymizer, token: vToken, amount: shares_A }`.
2. Calls `privacy_invoke(Withdraw, vToken, underlying, assets_A, note_A)` where `assets_A = convertToUnderlying(shares_A)` was computed off-chain at block T.
3. By block T+N (when the transaction executes), interest has accrued. The vault now needs fewer shares to produce `assets_A`. The vault burns `burned_A < shares_A`, leaving `leftover_A = shares_A - burned_A` in the anonymizer.
4. User A receives `assets_A` underlying in their open note. The leftover vTokens remain in the anonymizer with no recovery path.

### Theft vector

User B observes on-chain that the anonymizer holds `leftover_A` vTokens.

User B:
1. Sends `shares_B` vToken to the anonymizer via a Withdraw action (where `shares_B` is the minimum the privacy system will allow, e.g., 1 share).
2. Calls `privacy_invoke(Withdraw, vToken, underlying, assets_B, note_B)` where `assets_B = convertToUnderlying(shares_B + leftover_A)`.
3. The vault burns `shares_B + leftover_A` from the anonymizer's total balance.
4. The anonymizer receives `assets_B` underlying.
5. `out_amount = balance_after - balance_before = assets_B`.
6. The privacy contract calls `transferFrom(anonymizer, privacy_contract, assets_B)`.
7. User B's open note is credited `assets_B` — which corresponds to MORE underlying than User B contributed.

User B has stolen `convertToUnderlying(leftover_A)` from User A with no cost other than their own transaction fee.

### Root cause

Two independent problems compound:

1. **Share/underlying mismatch with no slippage protection on the input side:** The privacy contract sends `shares` to the anonymizer, but the anonymizer calls `withdraw(assets)` using a separately provided `assets` parameter. There is no on-chain check that the burned shares equal the shares that were transferred in.

2. **Permissionless anonymizer with a global balance:** The anonymizer holds a single undifferentiated vToken balance. Any transaction can consume any portion of that balance regardless of which user deposited it.

### Why this is new (not covered by Hunter 14)

Hunter 14 identified that **stranded vTokens exist and are unrecoverable**. This finding goes further: stranded vTokens are not merely lost — they are **actively exploitable by a subsequent user** who calibrates the `assets` parameter to burn more shares than they contributed. Hunter 14 analyzed only the loss to the original user; this finding analyzes the gain to a subsequent attacker.

### Proof of exploitability

The attack requires only:
1. Public on-chain knowledge of the anonymizer's vToken balance (readable via `balanceOf`).
2. The ability to submit a transaction with `assets = convertToUnderlying(anonymizer_vToken_balance)`.
3. A valid open note for the underlying token (which the attacker creates legitimately).

All three conditions are achievable by any privacy pool participant.

### Recommended mitigations

**Option A (strongest):** After the vault operation, check that the anonymizer's remaining `in_token` balance has not decreased beyond what the transaction sent:
```cairo
let in_balance_after_withdrawal = in_erc20.balance_of(account: self_addr);
// Ensure the vault burned no more than the privacy contract sent this tx.
// Requires knowing how many shares were transferred — not available to the anonymizer.
```
Unfortunately, the anonymizer cannot distinguish "shares sent this tx" from "stranded shares from previous txs" without additional bookkeeping.

**Option B (practical):** After the vault operation, transfer any remaining `in_token` balance back to the privacy contract:
```cairo
let remaining_in = in_erc20.balance_of(account: self_addr);
if remaining_in.is_non_zero() {
    in_erc20.transfer(recipient: privacy_addr, amount: remaining_in);
}
```
This prevents stranding but does not address in-flight exploitation (the attacker can still use the stranded shares from a previous tx before they are returned).

**Option C (design-level fix):** The privacy contract should pass `in_amount` (the shares it transferred) to the anonymizer via calldata. The anonymizer then asserts that the vault burned exactly `in_amount` shares (by checking `in_balance_before - in_balance_after == in_amount`). This ensures the shares consumed match what was sent, preventing any cross-user contamination.

---

## Finding 2 (MEDIUM): `clear(in_token)` Semantics Mismatch — Variable Name `in_token_remaining` Is Wrong; Partial-Fill Tokens Already Transferred Before Assert

**File:** `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo:139-142`

**Severity:** Medium (code correctness / misleading invariant)

### Description

```cairo
let in_token_remaining = clear
    .clear(token: EkuboIERC20Dispatcher { contract_address: in_token });
assert(in_token_remaining.is_zero(), errors::IN_TOKEN_NOT_CLEARED);
```

The variable is named `in_token_remaining`, implying it represents tokens still held by the router. In fact, Ekubo's `clear` function **sweeps the router's in_token balance to the caller** and returns the swept amount. The mock confirms:

```cairo
fn clear_minimum(self: @ContractState, token: EkuboIERC20Dispatcher, minimum: u256) -> u256 {
    let balance = token.balanceOf(get_contract_address()); // router's current balance
    ...
    token.transfer(get_caller_address(), balance); // sends TO anonymizer
    balance // returns what was swept
}
```

So when `clear(in_token)` returns non-zero:
1. The router has already **transferred** the partial-fill in_token amount back to the anonymizer.
2. The assert fires.
3. The entire transaction reverts — including the transfer back.

The final state is correct (no stranded tokens), but the sequence of events is counterintuitive:
- The code asserts that `in_token_remaining.is_zero()`, but the actual invariant being enforced is "no in_token was swept back from the router," not "no in_token remains on the router."
- If `clear` sent tokens back, they exist briefly in the anonymizer's balance window before the revert undoes them.

### Why this matters

The misleading variable name can cause future maintainers to reason incorrectly about the invariant. A developer might mistakenly think:
- `in_token_remaining == 0` means "no in_token left on router" (correct conclusion, but reached via wrong semantics).
- `in_token_remaining > 0` means "router still holds tokens" (wrong — the router already sent them to the anonymizer).

If a future change adds logging or emits events before the assert, or if Cairo adds try/catch semantics that allow partial state capture, the brief window where the anonymizer holds the swept tokens could become observable or exploitable.

### Concrete scenario where semantics matter

Suppose the Ekubo router implementation changes and `clear` returns the amount remaining on the router (rather than the swept amount). Then `in_token_remaining.is_zero()` would mean "router has zero remaining" — which would pass even in a partial fill case (if the router returned leftover tokens to the anonymizer through a different mechanism). The invariant would be silently broken.

### Recommendation

Rename the variable to `in_token_cleared_back` and update the assertion comment to clarify that a non-zero value means "tokens were returned from the router due to partial fill, indicating an incomplete swap":

```cairo
// `clear` returns the amount swept from the router back to us.
// Any non-zero value means the swap was partial (some input was not consumed).
let in_token_cleared_back = clear
    .clear(token: EkuboIERC20Dispatcher { contract_address: in_token });
assert(in_token_cleared_back.is_zero(), errors::IN_TOKEN_NOT_CLEARED);
```

This is a low-severity finding on its own, but is material when combined with Finding 3 below.

---

## Finding 3 (MEDIUM): Ekubo Anonymizer Does Not Validate That It Holds Sufficient In-Token Before Transferring to Router

**File:** `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo:130-132`

**Severity:** Medium (misleading error path, potential token loss if balance check is bypassed)

### Description

```cairo
checked_transfer(
    token_address: in_token, recipient: router_addr, amount: in_amount.into(),
);
```

`checked_transfer` is a thin wrapper that calls `transfer(router_addr, in_amount)` on the anonymizer's behalf. If the anonymizer holds less than `in_amount` of `in_token`, the ERC20 transfer fails with `ERC20: insufficient balance` rather than a more descriptive error from the anonymizer itself.

More importantly: the anonymizer has no internal accounting of which portion of its `in_token` balance was legitimately transferred in by the privacy contract for this transaction versus tokens that were deposited in error by other sources (e.g., accidental direct transfers, stranded tokens from previous transactions).

### Scenario

1. The privacy contract transfers `amount_A = 1000` in_token to the anonymizer.
2. The anonymizer also has `stranded = 500` in_token from a prior failed/aborted operation (which the privacy contract did not send this transaction).
3. `privacy_invoke` is called with `in_amount = 1000`.
4. `checked_transfer(in_token, router, 1000)` succeeds (anonymizer balance = 1500 ≥ 1000).
5. The router swap executes on 1000 tokens.
6. The stranded 500 tokens remain in the anonymizer.

This is the expected behavior for the amounts in this example. But if the user specified `in_amount = 1500` in calldata (consuming the stranded tokens too), step 4 would send 1500 to the router, and the user would get swap output on 1500 — effectively consuming the stranded tokens that they didn't deposit in this transaction.

The privacy contract enforces via `token_balances` that the user can only withdraw what they put in (via UseNote or Deposit). But the `InvokeExternal` calldata is not token-balance-checked. The anonymizer receives `amount = in_amount_from_token_balances` from the privacy contract, but the calldata passed to `privacy_invoke` can independently specify a different `in_amount`. If calldata specifies a larger `in_amount`, the transfer is attempted for that larger amount — but the anonymizer may not have enough. If calldata specifies a smaller `in_amount`, the remaining tokens stay stranded.

### Why this is a real issue

The calldata's `in_amount` in the Ekubo anonymizer is entirely separate from the amount the privacy contract transferred. The privacy contract enforces balance accounting at compile time (via `token_balances` in `main`), but the `InvokeExternal` action carries opaque calldata that the privacy contract does not inspect. A user who constructs calldata with `in_amount != amount_withdrawn` creates a mismatch:

- `in_amount < amount_withdrawn`: anonymizer receives `amount_withdrawn`, sends only `in_amount` to router, the difference strands in the anonymizer.
- `in_amount > amount_withdrawn`: requires the anonymizer to have pre-existing tokens; if not, reverts.

In the first sub-case, the stranded `amount_withdrawn - in_amount` of in_token accumulates in the anonymizer, exposed to the cross-user theft scenario described in Finding 1 (Vesu) — or the stranded tokens could be used in a future swap invocation.

### Recommendation

The anonymizer should validate that `in_amount` does not exceed the tokens available from this transaction's transfer. Since the anonymizer has no per-transaction accounting, the simplest fix is for the privacy contract to pass the exact `amount` from the `Withdraw` action through the `InvokeExternal` calldata, and for the server to validate this equivalence. Alternatively, the anonymizer could accept a `max_in_amount` parameter and consume exactly what it has up to that maximum — but this changes the interface.

---

## Confirmed Non-Issues (with reasoning)

### Non-Issue: Transaction atomicity prevents frontrunning between `TransferTo` and `Invoke`

`_apply_actions` processes `TransferTo(anonymizer, in_token, amount)` before `Invoke(anonymizer, calldata)` in a single Starknet transaction. Starknet transactions are sequential and atomic. No external actor can intercept between these two server actions. The window where the anonymizer holds tokens without the subsequent invoke never exists externally.

### Non-Issue: `balance_before` / `balance_after` correctly excludes pre-existing balance

Both anonymizers measure output via `balance_after - balance_before`. This delta correctly excludes any pre-existing out_token balance held by the anonymizer, so pre-existing balances do not inflate the reported `out_amount`. (This also means pre-existing balances are not credited to the current user — they remain stranded.)

### Non-Issue: Revert semantics protect against `_deposit_to_open_note` before `checked_sub` panic

When `checked_sub` panics with `TOO_MANY_OPEN_NOTES_DEPOSITED`, Cairo's all-or-nothing revert semantics undo all prior state changes including `_deposit_to_open_note` writes and ERC20 transfers. No partial state survives.

### Non-Issue: `clear(in_token)` assert correctly prevents partial-fill token stranding

If `clear(in_token)` returns non-zero (indicating a partial fill), the assert fires and the entire transaction reverts — including the `checked_transfer(in_token, router, in_amount)` that preceded it. No tokens are stranded.

### Non-Issue: Multiple `InvokeExternal` actions per transaction are correctly prevented

`assert_and_advance_phase` advances `curr_phase` to 8 after the first `InvokeExternal`, making any second one fail with `ACTIONS_OUT_OF_ORDER`. This ensures at most one anonymizer call per transaction.

### Non-Issue: The approval race condition does not exist

The anonymizer's `approve(privacy_addr, out_amount)` is followed immediately by the privacy contract's `transferFrom(anonymizer, privacy_contract, out_amount)` in the same transaction. The approval is set and consumed atomically. No race between these steps is possible.

---

## Summary

| # | Severity | Title |
|---|----------|-------|
| 1 | HIGH | Stranded vTokens in Vesu anonymizer enable cross-user theft of underlying |
| 2 | MEDIUM | `clear(in_token)` semantics mismatch — misleading invariant around partial-fill token transfer |
| 3 | MEDIUM | Ekubo anonymizer does not validate `in_amount` matches the tokens received from the privacy contract |
