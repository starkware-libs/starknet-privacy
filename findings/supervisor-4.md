# Security Supervisor 4 — Validation Report for Hunters 13–16

All findings were validated by reading the actual source code at the cited locations.
Primary sources examined:
- `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo` (all 163 lines)
- `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo` (all 177 lines)
- `packages/privacy/src/privacy.cairo` (lines 790–915, 975–1022)
- `packages/privacy/src/errors.cairo` (all 69 lines)

---

## H13 — Ekubo Swap Anonymizer (Hunter 13)

### H13-B1: in_token pre-funding precondition is external

**Verdict: CONFIRMED (design-level observation, not a standalone bug)**
**Severity: INFO**

The anonymizer's `checked_transfer` at line 130 of `ekubo_swap_anonymizer.cairo` does transfer tokens FROM the anonymizer TO the router — requiring the anonymizer to hold them in advance. `_apply_invoke` in `privacy.cairo` lines 870–881 confirms there is no token transfer before the `call_contract_syscall`. This is accurately described. Hunter 13 correctly identifies it as a documented precondition rather than a contract bug, and notes it safely reverts on under-funding. The assessment is accurate.

### H13-B2 through H13-B5, H13-B7: Correctly identified as non-bugs

**Verdict: CONFIRMED as non-bugs**
**Severity: N/A**

The balance-delta calculation (`balance_before` before `clear_minimum`, `balance_after` after) is verified correct at lines 146–154 of `ekubo_swap_anonymizer.cairo`. The approval-amount equality, `clear(in_token)` partial-fill enforcement, and the u128 ceiling on `minimum_received` observations are all factually accurate. No bugs here.

### H13-B6: Unauthenticated `privacy_invoke` — front-running / griefing

**Verdict: CONFIRMED**
**Severity: HIGH**

Verified from code: `privacy_invoke` in `ekubo_swap_anonymizer.cairo` has no access control whatsoever. Line 127 captures `privacy_addr = get_caller_address()` and line 159 does `out_erc20.approve(spender: privacy_addr, amount: out_amount.into())`. If an adversary calls `privacy_invoke` directly:

1. They pre-fund the anonymizer OR observe a victim's pre-funding transaction.
2. They call `privacy_invoke` with a `note_id` they control, providing any valid `router_addr`, `pool_key`, and `token_amount`.
3. The swap executes: `in_token` (belonging to the victim) is consumed; `out_token` is received by the anonymizer and approved to the adversary's address (`get_caller_address()`).
4. The adversary calls `out_erc20.transferFrom(anonymizer_addr, adversary_addr, out_amount)` to drain the approval.
5. Victim's subsequent `apply_actions` finds the anonymizer unfunded and reverts. The victim loses their `in_token` permanently.

This is a genuine fund-loss scenario. The attack is executable as described.

---

## H14 — Ekubo Swap Anonymizer (Hunter 14)

### H14-F1: balance_before/after subtraction safety

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

`clear_minimum` can only add tokens to the anonymizer. Subtraction is safe. Consistent with code.

### H14-F2: clear ordering safety

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

`clear(in_token)` and `clear_minimum(out_token)` operate on distinct ERC-20 token balances; ordering has no cross-effect. Confirmed.

### H14-F3: i129 sign convention correctness

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

`assert(!sign, errors::NEGATIVE_AMOUNT)` at line 116 correctly rejects negative sign-magnitude values. The zero-mag + true-sign edge case is caught by the subsequent `ZERO_IN_AMOUNT` check at line 117. Confirmed correct.

### H14-F4: Missing `out_token` zero check

**Verdict: CONFIRMED (real bug)**
**Severity: LOW**

Verified at lines 119–124 of `ekubo_swap_anonymizer.cairo`: `in_token` is checked for zero at line 115, but `out_token` derived from the pool key is never checked for zero. A caller supplying `pool_key.token1 = 0` with `in_token == pool_key.token0` obtains `out_token = 0`. Dispatching to address 0 on Starknet causes a low-level syscall failure rather than the descriptive `ZERO_OUT_TOKEN` error. The fix is a single assertion after derivation. The `in_token == out_token` edge case (same token in pool key) is also unguarded but results in a non-descriptive router revert. Hunter 14's analysis is accurate.

### H14-F5: Redundant coverage

**Verdict: N/A** (correctly identified as covered by F4)

### H14-F6: Reentrancy via approve

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

Starknet's sequential execution model prevents reentrancy at the protocol level. No persistent state to corrupt. Correct analysis.

### H14-F7: No access control on `privacy_invoke` — acknowledged non-bug

**Verdict: REJECTED**
**Severity: HIGH (disagrees with Hunter 14)**

Hunter 14 argues the stateless design makes access control unnecessary because a direct caller "cannot extract value beyond what they put in." This reasoning is **incorrect**. See the adjudication section below. The caller can extract the victim's pre-funded tokens. Hunter 14's conclusion on this finding is wrong.

---

## H15 — Vesu Lending Anonymizer (Hunter 15)

### H15-B1: Deposit requires pre-funding — not enforced

**Verdict: SUSPECTED (design gap, not a standalone critical bug)**
**Severity: MEDIUM**

Verified from `vesu_lending_anonymizer.cairo` lines 151–155: the Deposit path calls `in_erc20.approve(spender: out_token, amount: assets)` then `vToken.deposit(assets, receiver: self_addr)` where `vToken.deposit` pulls tokens from `self_addr`. The anonymizer must already hold `in_token`. No funding mechanism exists inside `privacy_invoke`.

However, Hunter 16 (Bug 7) correctly identifies how the intended funding mechanism works: a `Withdraw` client action (phase 6) compiles to `ServerAction::TransferTo` which, when directed at the anonymizer address, transfers tokens from the privacy contract to the anonymizer before the `Invoke` action runs (phase 7). This is a protocol-level design, not an enforcement gap within the anonymizer itself.

The actual risk: if a user constructs a transaction with `InvokeExternal` but no corresponding `TransferTo`, the transaction reverts — no funds are lost. Calling this "CRITICAL" overstates the severity. The revert is safe. The design is architecturally underspecified in documentation, not broken in implementation.

### H15-B2: Withdraw requires pre-funding with vTokens — not enforced

**Verdict: SUSPECTED (same as B1)**
**Severity: MEDIUM**

Same analysis applies. The vToken burn path at lines 157–160 requires the anonymizer to hold vToken shares. Same intended mechanism (prior `TransferTo`) applies. Clean revert on under-funding. Severity is overstated at CRITICAL.

### H15-B3: out_amount truncated to u128

**Verdict: CONFIRMED (known limitation, tested)**
**Severity: LOW**

Code at lines 164–167 of `vesu_lending_anonymizer.cairo` confirms the u128 cast with `RECEIVED_AMOUNT_OVERFLOW` guard. Hunter 15's assessment (tested, correct guard, limiting for large-supply tokens) is accurate.

### H15-B4: balance_before measurement timing

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

Balance-delta correctly measures only the new tokens received by the operation. Confirmed.

### H15-B5: Withdraw without prior approve

**Verdict: CONFIRMED (integration assumption)**
**Severity: LOW**

Code at lines 157–160 calls `vToken.withdraw(assets, receiver: self_addr, owner: self_addr)` with no preceding `approve`. The ERC-4626 standard exempts `owner == msg.sender` from allowance requirements. This is correct if Vesu complies with ERC-4626/SNIP-22. Marking it as a trust assumption is appropriate.

### H15-B6: balance_after underflow via reentrancy

**Verdict: SUSPECTED**
**Severity: LOW**

The subtraction at line 165 uses u256 arithmetic. In Cairo, u256 subtraction panics on underflow (it does not wrap). So if a malicious token reduced the balance during the operation, the transaction would revert — no fund loss. This is a griefing vector (malicious token causes revert), but not an exploitable fund-theft vector. Marking as MEDIUM overstates the impact; griefing reverts cause no fund loss.

### H15-B7: No upper bound on assets parameter

**Verdict: CONFIRMED (informational only)**
**Severity: INFO**

Clean revert on insufficient balance, and StarkNet atomicity rolls back the approve. No state corruption. Informational only, as Hunter 15 concludes.

---

## H16 — Cross-Contract Consistency (Hunter 16)

### H16-B1: DEPOSITOR_BLOCKED check skipped when anonymizer returns 0 deposits

**Verdict: CONFIRMED (real bug, scope depends on design intent)**
**Severity: MEDIUM**

Verified directly from `privacy.cairo` lines 798–816: the `DEPOSITOR_BLOCKED` assertion is inside `if !open_note_deposits.is_empty()`. The `_apply_invoke` call (line 799) runs unconditionally BEFORE the block check. A blocked anonymizer that returns an empty span will execute all its DeFi logic (swaps, vault deposits/withdrawals, ERC-20 approvals) without triggering the `DEPOSITOR_BLOCKED` assertion.

The severity depends on design intent:
- If `set_depositor_blocked` is meant to prevent invocation of the anonymizer (stronger semantics), this is a real bypass bug.
- If it is only meant to prevent deposits to open notes (weaker semantics, consistent with the interface doc: "cannot fund any open note"), the code is correct but the practical utility of blocking is limited since the anonymizer still executes.

The bug is real in the sense that the blocking check does not prevent execution side-effects. Moving the check before `_apply_invoke` would be strictly safer.

### H16-B2: Block targets anonymizer contract address, not user; bypass via redeployment

**Verdict: CONFIRMED (design property, worth documenting)**
**Severity: MEDIUM**

Verified: `blocked_depositors` maps `ContractAddress → bool`. Both anonymizers have empty storage structs and parameter-free constructors, so any user can deploy a bytecode-identical anonymizer at a new address, bypassing the block. This is not a code bug but an operational limitation that operators must understand. Hunter 16's analysis is accurate.

### H16-B3: Dead MULTIPLE_DEPOSITORS constant

**Verdict: CONFIRMED (dead code)**
**Severity: LOW**

Verified: `MULTIPLE_DEPOSITORS` appears only in `errors.cairo` line 54. A full codebase search confirms zero references outside that file. The constant is dead code. This was also identified by Hunter 8. Hunter 16's analysis is accurate.

### H16-B4: Cross-tx open note deposits — protected by NOTE_ALREADY_DEPOSITED

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

Verified from `_deposit_to_open_note` at line 899: `assert(current_amount.is_zero(), errors::NOTE_ALREADY_DEPOSITED)`. Any open note that persisted in storage from a prior transaction would have been deposited (non-zero amount) to pass that transaction's `UNDEPOSITED_OPEN_NOTES` check. So stale note IDs are blocked. Hunter 16's reasoning is correct; the recommendation to add a documenting comment is sound.

### H16-B5: User-controlled note_id

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

The privacy contract validates `note_id` at runtime through `NOTE_NOT_FOUND`, `NOTE_NOT_OPEN`, `NOTE_ALREADY_DEPOSITED`, and `TOKEN_MISMATCH` checks. User control of this field is correct by design.

### H16-B6: Zero deposits when no open note — correct revert

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

Consistent with the `UNDEPOSITED_OPEN_NOTES` enforcement. Correctly analyzed.

### H16-B7: Token flow relies on prior TransferTo in same tx

**Verdict: CONFIRMED as non-bug**
**Severity: INFO**

Hunter 16 correctly explains the phase ordering: `Withdraw` (phase 6) generates `TransferTo` before `InvokeExternal` (phase 7) generates `Invoke`. The design is correct; it is architecturally underspecified in documentation.

### H16-B8: Approval race / residual balance

**Verdict: CONFIRMED as non-bug**
**Severity: N/A**

Balance-delta and StarkNet transaction atomicity make this safe for standard tokens.

---

## ADJUDICATION: Hunter 13 vs Hunter 14 on `privacy_invoke` Access Control

### The Core Dispute

Hunter 13 classifies unauthenticated `privacy_invoke` as **HIGH severity** (fund theft). Hunter 14 classifies it as **not a bug** because "the stateless design makes access control unnecessary."

### Step-by-Step Analysis

**Step 1 — What does `privacy_addr = get_caller_address()` mean?**

In `ekubo_swap_anonymizer.cairo` line 127, `privacy_addr` is set to whoever calls `privacy_invoke`. In the intended flow (privacy contract calling via `call_contract_syscall`), this is the privacy contract address. When an adversary calls directly, `privacy_addr` becomes the adversary's address.

**Step 2 — What does `approve(spender: privacy_addr, ...)` achieve?**

Line 159: `out_erc20.approve(spender: privacy_addr, amount: out_amount.into())`. This grants the caller an ERC-20 allowance for `out_amount` of `out_token`. With this allowance, the caller can call `out_erc20.transferFrom(anonymizer_addr, adversary_addr, out_amount)` and receive the tokens directly.

**Step 3 — Does the adversary need to "also control the note"?**

No. The adversary does NOT need the privacy contract or any note. The `OpenNoteDeposit` return value is ignored by the adversary. They simply:
1. Pre-fund (or intercept victim pre-funding of) the anonymizer with `in_token`.
2. Call `privacy_invoke` directly with any valid parameters.
3. The swap runs: `in_token` → router → `out_token` → anonymizer.
4. The adversary now holds an ERC-20 approval for `out_token`.
5. The adversary calls `transferFrom` to collect.

**Step 4 — Is the victim actually harmed?**

Yes. The victim sent `in_token` to the anonymizer address before their `apply_actions` transaction. Those tokens have now been consumed in an adversary-controlled swap. The victim's `apply_actions` transaction finds the anonymizer unfunded and reverts. The `in_token` is permanently gone.

**Step 5 — Is Hunter 14's counter-argument valid?**

Hunter 14 argues: "They must pre-fund the anonymizer... A direct caller cannot extract value beyond what they put in." This is wrong in the front-running scenario. The adversary does NOT need to put any of their own tokens in — they exploit the victim's pre-funding. The statelessness argument is irrelevant: the anonymizer holds victim tokens in the brief window between the victim's funding step and the victim's `apply_actions` call.

### Definitive Verdict

**Hunter 13 is correct. Hunter 14 is wrong on Finding 7.**

The lack of access control on `privacy_invoke` is a genuine HIGH-severity bug because it enables a front-running attacker to:
- Steal the victim's pre-funded `in_token` (consumed in an adversary-directed swap)
- Collect the swap output (`out_token`) via the ERC-20 allowance granted to `get_caller_address()`

The attack requires no note control, no privacy contract interaction, and no victim cooperation beyond having pre-funded the anonymizer. The fix is straightforward: either require `get_caller_address() == hardcoded_privacy_contract_address`, or restructure the flow so the privacy contract atomically funds the anonymizer as part of `_apply_invoke` (eliminating the pre-funding window).

---

## Summary Table

| Finding | Hunter | Verdict | Severity |
|---------|--------|---------|----------|
| B6: Unauthenticated `privacy_invoke` — front-running fund theft | H13 | CONFIRMED | HIGH |
| B1–B5, B7: Non-bugs in balance/approval/clear logic | H13 | CONFIRMED (as non-bugs) | N/A |
| F4: Missing `out_token` zero check after derivation | H14 | CONFIRMED | LOW |
| F7: No access control — "not a bug" claim | H14 | REJECTED (it is a bug) | — |
| F1–F3, F5–F6: Non-bugs in sign/balance/reentrancy | H14 | CONFIRMED (as non-bugs) | N/A |
| B1: Deposit requires pre-funding (severity overstated) | H15 | SUSPECTED | MEDIUM |
| B2: Withdraw requires pre-funding (severity overstated) | H15 | SUSPECTED | MEDIUM |
| B3: out_amount u128 ceiling | H15 | CONFIRMED | LOW |
| B4: balance_before timing | H15 | CONFIRMED (as non-bug) | N/A |
| B5: Withdraw without approve (ERC-4626 assumption) | H15 | CONFIRMED | LOW |
| B6: Reentrancy underflow griefing (severity overstated) | H15 | SUSPECTED | LOW |
| B7: assets = u256::MAX — clean revert | H15 | CONFIRMED (informational) | INFO |
| B1: DEPOSITOR_BLOCKED bypass via empty return | H16 | CONFIRMED | MEDIUM |
| B2: Block bypass via anonymizer redeployment | H16 | CONFIRMED | MEDIUM |
| B3: Dead MULTIPLE_DEPOSITORS constant | H16 | CONFIRMED | LOW |
| B4: Cross-tx note targeting — protected | H16 | CONFIRMED (as non-bug) | N/A |
| B5: User-controlled note_id — correct design | H16 | CONFIRMED (as non-bug) | N/A |
| B6: Zero deposits — correct revert | H16 | CONFIRMED (as non-bug) | N/A |
| B7: Token flow — correct design | H16 | CONFIRMED (informational) | INFO |
| B8: Approval race — safe | H16 | CONFIRMED (as non-bug) | N/A |

---

## Top Confirmed Bugs

1. **[HIGH] Unauthenticated `privacy_invoke` — front-running fund theft** (Hunter 13, B6)
   File: `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`
   Adversary can intercept victim's pre-funded tokens by calling `privacy_invoke` directly before the victim's `apply_actions` transaction, consuming `in_token` in an adversary-directed swap and collecting the `out_token` output via the ERC-20 allowance granted to `get_caller_address()`.

2. **[MEDIUM] DEPOSITOR_BLOCKED check skipped when anonymizer returns empty deposit list** (Hunter 16, B1)
   File: `packages/privacy/src/privacy.cairo`, lines 799–813
   A blocked anonymizer that returns `[]` from `privacy_invoke` executes all its DeFi logic without triggering the `DEPOSITOR_BLOCKED` assertion because the check is gated inside `if !open_note_deposits.is_empty()`.

3. **[MEDIUM] Block-by-anonymizer-address bypass via fresh deployment** (Hunter 16, B2)
   Both anonymizers have empty storage and parameter-free constructors. Blocking an anonymizer address provides no protection against redeployment of an identical contract at a new address.

4. **[LOW] Missing `out_token` zero check in Ekubo anonymizer** (Hunter 14, F4)
   File: `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`, lines 119–124
   `out_token` derived from pool key is never validated for zero. Supplying `pool_key.token1 = 0` causes a non-descriptive low-level syscall failure instead of a clear `ZERO_OUT_TOKEN` error.

5. **[LOW] Dead `MULTIPLE_DEPOSITORS` error constant** (Hunter 16, B3)
   File: `packages/privacy/src/errors.cairo`, line 54
   Defined but never referenced; signals an abandoned design constraint.

6. **[LOW] Vesu Withdraw assumes ERC-4626 owner == msg.sender allowance exemption** (Hunter 15, B5)
   Trust assumption about Vesu's compliance with ERC-4626/SNIP-22. Low risk given documented compliance.

7. **[LOW] Vesu out_amount u128 ceiling** (Hunter 15, B3)
   Architecturally limiting for tokens with supply > u128::MAX; correctly guarded but undocumented.
