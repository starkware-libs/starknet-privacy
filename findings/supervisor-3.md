# Supervisor 3 — Audit Verdicts: Ekubo Swap Anonymizer & Vesu Lending Anonymizer

**Date:** 2026-06-15
**Scope:** Hunters 9, 10, 11, 12 findings on `ekubo_swap_anonymizer.cairo` and `vesu_lending_anonymizer.cairo`, cross-referenced against source and `privacy.cairo` lines 800–975.

**Note:** Hunter 9 and Hunter 10 report files were not found in the findings directory. Their claimed findings are reconstructed from the task brief and validated directly against source code. All verdicts are based on first-principles code tracing.

---

## Summary Table

| Hunter | Finding | Claimed Severity | Verdict | Supervisor Severity |
|--------|---------|-----------------|---------|---------------------|
| 9 | Stale ERC20 approval on out_token after swap | Medium | REJECTED | — |
| 10 | Untrusted `router_addr` allows in_token drain | Medium | INFORMATIONAL | Informational |
| 11-BUG1 | Residual in_token approval not cleared after deposit | Low | SUSPECTED | Low |
| 11-BUG2 | Stranded in_token when `assets < anonymizer_balance` | Medium | CONFIRMED | Medium |
| 12-F2 | `assets > u128::MAX` causes RECEIVED_AMOUNT_OVERFLOW | Informational | CONFIRMED | Informational |
| 12-F3 | No caller authentication on `privacy_invoke` | Low–Medium | CONFIRMED | Medium (conditional) |

---

## Detailed Verdicts

### Hunter 9 Finding 1 — Stale ERC20 Approval on out_token (Ekubo)

**Claim:** The Ekubo anonymizer's `approve(privacy_addr, out_amount)` call for the output token creates a stale approval if a prior call left out_token in the anonymizer.

**Code trace:**

The Ekubo anonymizer (`ekubo_swap_anonymizer.cairo`, lines 146–159) does:

1. Snapshots `balance_before = out_erc20.balance_of(self_addr)` BEFORE `clear_minimum`.
2. Calls `clear_minimum(out_token, minimum_received)` which transfers all pending out_token from the router to the anonymizer.
3. Snapshots `balance_after` and computes `out_amount = balance_after - balance_before`.
4. Approves `privacy_addr` for exactly `out_amount`.

The `balance_before` / `balance_after` delta pattern means that any pre-existing out_token balance held by the anonymizer is correctly excluded from `out_amount`. The approval is set to exactly `balance_after - balance_before` — not to `balance_after`. The privacy contract then calls `_deposit_to_open_note`, which executes `checked_transfer_from(sender: anonymizer, amount: out_amount)`. After this transfer, the anonymizer's out_token balance reverts to whatever it was before (i.e., the pre-existing balance, if any, is untouched).

**Crucially:** The Ekubo anonymizer has **no `approve` call for in_token at any point**. In_token is sent directly via `checked_transfer(token_address: in_token, recipient: router_addr, amount: in_amount.into())`. There is no approval to go stale for in_token.

**Verdict: REJECTED.** The stale approval scenario cannot arise in Ekubo. The `balance_before`/`balance_after` delta isolates exactly the newly received out_token, and the approval is set to that exact delta. There is no mechanism by which a prior call could cause the approval to be set incorrectly. The finding is factually incorrect about the Ekubo anonymizer's approval flow.

---

### Hunter 10 Finding 1 — Untrusted `router_addr` Allows in_token Drain (Ekubo)

**Claim:** Because `router_addr` is user-supplied via calldata, a malicious router could take in_token without returning out_token, draining the user's funds.

**Code trace:**

The flow for a user using the Ekubo anonymizer:
1. Privacy server action `TransferTo(to_addr: ekubo_anonymizer, token: in_token, amount: X)` — privacy contract sends X of in_token to the anonymizer.
2. Privacy server action `Invoke(ekubo_anonymizer, [router_addr, ...])` — privacy contract calls `privacy_invoke` on the anonymizer with user-supplied calldata.
3. Inside `privacy_invoke`: `checked_transfer(in_token, router_addr, in_amount)` sends in_token to the router.
4. `router.swap(...)` is called. A malicious router could consume in_token without emitting out_token to the router's clearing pool.
5. `clear(in_token)` is called and `assert(in_token_remaining.is_zero())` fires — this check catches the case where in_token was NOT fully consumed by the swap.
6. `clear_minimum(out_token, minimum_received)` enforces a minimum out_token return.

**Who is harmed?** The user who constructed the transaction specifies `router_addr` in their own calldata. The in_token being consumed was the user's own funds (withdrawn from their privacy note). A malicious router harms only the transaction submitter. The privacy protocol itself has no whitelist of approved routers.

**Is this a protocol vulnerability?** The privacy contract does not validate `router_addr`. However:
- The user is the sole author of the calldata that supplies `router_addr`.
- The only party harmed by a malicious router is the user who chose it.
- This is equivalent to a user voluntarily approving a malicious DeFi contract — a user-error class of failure, not a protocol security flaw.
- The `IN_TOKEN_NOT_CLEARED` and `clear_minimum` checks provide meaningful protection against partial fills and slippage.

**Verdict: INFORMATIONAL.** The absence of a router allowlist is a design choice, not a security bug. The user controls `router_addr` and bears the risk of choosing a malicious one. The contract provides slippage protection (`clear_minimum`) and full-fill enforcement (`IN_TOKEN_NOT_CLEARED`). Recommending documentation of this trust assumption is appropriate. No severity assigned.

---

### Hunter 11 Finding 1 (BUG-1) — Residual in_token Approval Not Cleared After Deposit (Vesu)

**Claim:** After `in_erc20.approve(out_token, assets)` followed by `IVTokenDispatcher(out_token).deposit(assets, self_addr)`, if the vault pulls fewer than `assets` of in_token (due to rounding or fees), a residual allowance remains permanently on the anonymizer.

**Code trace (`vesu_lending_anonymizer.cairo`, lines 151–156):**

```cairo
in_erc20.approve(spender: out_token, amount: assets);
IVTokenDispatcher { contract_address: out_token }
    .deposit(:assets, receiver: self_addr)
```

ERC-4626 `deposit(assets, receiver)` is specified to pull exactly `assets` of underlying (the asset amount is the exact input). Unlike `mint`, which takes shares as input and computes assets, `deposit` treats `assets` as exact. The vault pulls exactly `assets` via `transferFrom(caller, vault, assets)`. No rounding occurs on the deposit path by ERC-4626 specification.

**However**, the hunter's concern is valid for non-standard or upgraded vaults: Vesu is described as SNIP-22 compatible but the interface is not enforced to be strictly standard. A vault that pulls `assets - fee` would leave a residual allowance of `fee` on `in_erc20` for spender `out_token`. Since the anonymizer never calls `approve(out_token, 0)` to reset, this residual persists until the next deposit call overwrites it with a new `approve` (ERC-20 `approve` is a set, not increment).

**Exploitability:** Requires the Vesu vToken contract itself to be non-standard or malicious. Given that `out_token` is a trusted Vesu vault (protocol-level assumption), the residual allowance can only be exploited if the vToken contract is malicious or buggy. The protocol's trust model for Vesu vaults limits this to a defense-in-depth gap.

**Verdict: SUSPECTED.** The residual-allowance scenario is real for non-standard vault behavior, but the threat model already requires trusting Vesu vToken contracts. Under that trust assumption, the risk is low. The fix (reset approval to zero post-deposit) is best practice and costs one extra call. Classified as Low severity — a hardening recommendation.

---

### Hunter 11 Finding 2 (BUG-2) — Stranded in_token When `assets < anonymizer_balance` (Vesu)

**Claim:** If the user supplies an `assets` parameter smaller than the in_token amount sent to the anonymizer, the difference is permanently stranded with no recovery path.

**Code trace:**

Step 1: Privacy contract executes `_apply_transfer_to(to_addr: vesu_anonymizer, token: in_token, amount: X)` — sends exactly X of in_token to the anonymizer.

Step 2: Privacy contract executes `_apply_invoke(vesu_anonymizer, calldata_with_assets=Y)` — calls `privacy_invoke(Deposit, in_token, out_token, assets: Y, note_id)`.

Step 3: Inside `privacy_invoke`: `in_erc20.approve(out_token, Y)`, then `deposit(Y, self_addr)`. The vault pulls exactly Y of in_token.

Step 4: If Y < X: the anonymizer holds (X - Y) of in_token with no code path to recover it.

**Does the privacy contract's token_balances tracking catch this?**

Tracing through `privacy.cairo`:
- `UseNote` adds X to `token_balances[in_token]`.
- `Withdraw(to_addr: anonymizer, token: in_token, amount: X)` (a `ServerAction::TransferTo`) subtracts X from `token_balances[in_token]`.
- `token_balances.squash().assert_valid()` checks all balances are zero — satisfied when Withdraw amount matches UseNote amount, regardless of what the anonymizer does internally.
- The `Invoke` server action has no interaction with `token_balances` at all (line 824 of `privacy.cairo` — the `ServerAction::Invoke` arm does not touch token_balances).

The privacy contract has no on-chain mechanism to detect that the anonymizer only consumed Y of the X tokens it received.

**Is there a recovery path?**

The anonymizer contract has:
- Empty `Storage` struct — no persistent state.
- No admin, owner, or sweep function.
- No `Withdraw` operation for raw in_token (only for vToken).
- The Withdraw operation burns vTokens to get underlying back — it cannot reclaim already-stranded underlying without first depositing it, creating a circular dependency.

**Who causes this?** The user constructs both the `amount` field in `Withdraw` (X) and the `assets` field in `InvokeExternal` calldata (Y). A correctly implemented client will set Y == X. There is no on-chain enforcement of this invariant.

**Is this a protocol bug or user error?** The protocol provides no protection against Y < X. While a correct client never generates this state, the contract offers no on-chain safeguard. The simplest fix — reading `balance_of(self_addr)` rather than trusting the caller-supplied `assets` — would make the deposit atomic with respect to the anonymizer's balance.

**Verdict: CONFIRMED — Medium severity.** Funds can be permanently lost with no recovery. The root cause is that `assets` is a user-controlled parameter not validated against the anonymizer's actual in_token balance. The fix is to replace `assets` with `in_erc20.balance_of(self_addr)` inside `privacy_invoke` for the Deposit branch, consuming the entire received balance atomically.

---

### Hunter 12 Finding 2 — `assets > u128::MAX` Causes RECEIVED_AMOUNT_OVERFLOW (Vesu Withdraw)

**Claim:** Passing `assets = 2^128` or larger causes `RECEIVED_AMOUNT_OVERFLOW` panic after the vault call.

**Code trace:**

```cairo
let out_amount: u128 = (balance_after - balance_before)
    .try_into()
    .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
```

If `assets > u128::MAX`, the vault's `withdraw(assets, ...)` must first succeed. For the vault to succeed, the anonymizer must hold enough vToken shares to cover `assets` underlying — which requires vToken deposits exceeding u128::MAX in value. In practice, this is unreachable because ERC-20 token supplies are bounded by their own storage types (typically u256 with practical values far below u128::MAX for real assets).

If it were somehow reachable (e.g., a pathological vault with artificial share prices), the vault reverts before `RECEIVED_AMOUNT_OVERFLOW` is reached.

**Verdict: CONFIRMED — Informational.** The overflow path is unreachable in practice because the vault's own balance check acts as an implicit cap. The fix (adding `assert(assets.high == 0, 'ASSETS_EXCEEDS_U128')` before the vault call) is a good defensive hardening measure and improves auditability, but this is not an exploitable vulnerability.

---

### Hunter 12 Finding 3 — No Caller Authentication on `privacy_invoke` (Vesu)

**Claim:** Any address can call `privacy_invoke` directly. If the anonymizer holds tokens, a malicious caller could steal them.

**Code trace:**

Both anonymizers read `privacy_addr = get_caller_address()` and approve that caller for the output amount:

```cairo
let privacy_addr = get_caller_address();
// ...
out_erc20.approve(spender: privacy_addr, amount: out_amount.into());
```

There is no `assert(privacy_addr == <known_privacy_contract>, ...)`.

**When can the anonymizer hold tokens between calls?**

In normal protocol operation, the anonymizer receives tokens only in the same atomic transaction as the `privacy_invoke` call, via `_apply_transfer_to` followed immediately by `_apply_invoke`. Between transactions, the anonymizer should hold no tokens.

However, Hunter 11 Finding 2 (CONFIRMED above) establishes a realistic scenario where in_token is stranded in the Vesu anonymizer: if `assets < transferred_amount` on a Deposit operation, the excess in_token remains permanently.

**Combined attack path (Vesu):**

1. Victim's transaction strands (X - Y) of in_token in the Vesu anonymizer (e.g., due to a client bug or off-by-one).
2. Attacker observes the stranded balance on-chain.
3. Attacker calls `privacy_invoke(Deposit, in_token=stranded_token, out_token=vToken, assets=stranded_amount, note_id=arbitrary)` directly.
4. The anonymizer deposits the stranded in_token into the vault, receives vTokens, approves the **attacker** (as `privacy_addr`) to spend them.
5. Attacker calls `transfer_from(anonymizer, attacker, vToken_amount)`.
6. `note_id` is arbitrary — `_deposit_to_open_note` is never called in this path (the attacker is calling `privacy_invoke` directly, not through the privacy contract).

This is a real theft path that combines the stranding bug (Hunter 11 F2) with the missing access control. Neither vulnerability is exploitable alone without the other in this exact scenario for in_token.

**For vToken stranding (Hunter 14 Finding 1):** If excess vTokens accumulate in the anonymizer due to share price drift during Withdraw, an attacker can call `privacy_invoke(Withdraw, in_token=vToken, out_token=underlying, assets=stranded_vTokens, note_id=arbitrary)`, receiving the underlying and getting the attacker-address approved for it.

**Verdict: CONFIRMED — Medium severity.** The missing access control is exploitable when tokens are stranded in the anonymizer (a condition confirmed to be reachable via Hunter 11 F2 and Hunter 14 F1). The fix is to store the privacy contract address in constructor storage and assert `get_caller_address() == privacy_contract_address` at the start of `privacy_invoke`.

---

## Cross-Hunter Consistency Notes

**Hunter 11 F2 ↔ Hunter 12 F3 (Vesu):** These two findings compose into a theft vector. Stranded in_token (H11-F2) + unauthenticated `privacy_invoke` (H12-F3) allows a third party to steal the stranded funds. Both findings are individually confirmed; together they escalate the combined risk.

**Hunter 14 F1 (Vesu Withdraw excess vTokens) ↔ Hunter 12 F3:** Hunter 14 found a separate stranding mechanism (share price drift in Withdraw leaving excess vTokens). Combined with H12-F3, this is also a theft vector. Hunter 14's finding is not in scope for Supervisor 3 but is noted here for completeness.

**Hunter 10 (untrusted router) vs. Hunter 9 (stale approval):** These were framed as different issues but both are REJECTED/INFORMATIONAL because:
- The Ekubo anonymizer has no in_token approval (uses direct transfer).
- The out_token approval is set to the exact delta, making stale approvals impossible.
- The `router_addr` is user-controlled but only harms the user who chose it.

---

## Recommended Fixes (Priority Order)

1. **[Critical path] Add constructor-stored privacy contract address to both anonymizers.** Assert `get_caller_address() == privacy_contract_address` in `privacy_invoke`. This closes the unauthenticated access path (H12-F3).

2. **[Medium] Use full in_token balance instead of caller-supplied `assets` in Vesu Deposit.** Replace `assets` with `in_erc20.balance_of(account: self_addr)` to prevent stranding (H11-F2). This also eliminates the composition with H12-F3 for the in_token theft path.

3. **[Low] Reset in_token approval to zero after Vesu deposit.** Add `in_erc20.approve(spender: out_token, amount: 0)` after the vault's `deposit` call (H11-F1).

4. **[Informational] Add `assets.high == 0` assertion in Vesu Withdraw.** Explicit upper-bound guard before the vault call (H12-F2).

5. **[Informational] Document `router_addr` trust assumption.** Add a comment in Ekubo's `privacy_invoke` that `router_addr` is user-controlled and the user bears the risk of choosing a malicious router (H10-F1).
