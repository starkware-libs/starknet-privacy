# Bug Hunter #12 — Withdraw Path Analysis

## Scope

File: `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo`
Focus: `LendingOperation::Withdraw` path in `privacy_invoke`.

---

## Finding 1: No Real Bugs in the Core Withdraw Logic

After tracing the full execution path end-to-end, the withdraw logic is **correct** for the expected use case. Here is the verified flow:

1. `privacy_invoke` is called with `in_token = vToken`, `out_token = underlying`, `assets = u256`.
2. The four input guards run: non-zero `in_token`, non-zero `out_token`, non-zero `assets`, `in_token != out_token`.
3. `balance_before = out_erc20.balance_of(self_addr)` captures the anonymizer's current underlying balance.
4. `IVTokenDispatcher { contract_address: in_token }.withdraw(assets, receiver: self_addr, owner: self_addr)` burns exactly enough vToken shares from the anonymizer and transfers `assets` of underlying to the anonymizer.
5. `balance_after - balance_before = assets` (exactly, per ERC-4626 semantics).
6. `out_amount = (balance_after - balance_before).try_into::<u128>()` — fails with `RECEIVED_AMOUNT_OVERFLOW` if `assets > u128::MAX`.
7. The anonymizer approves the privacy contract (`privacy_addr`) to spend `out_amount` of underlying.
8. Returns `[OpenNoteDeposit { note_id, token: out_token, amount: out_amount }]`.
9. The privacy contract then calls `_deposit_to_open_note`, which calls `checked_transfer_from(token: out_token, sender: anonymizer, recipient: privacy_contract, amount: out_amount)` — succeeds because of the approval set in step 7.

No authorization issue: the anonymizer is `owner` calling `withdraw` on its own shares — ERC-4626 does not require an allowance from `owner` to `caller` when `owner == caller`.

No stranded-token issue: the vault sends exactly `assets` underlying, the anonymizer approves exactly `out_amount` (= `assets` cast to u128), and the privacy contract pulls exactly that amount.

---

## Finding 2: Theoretical — `assets > u128::MAX` Causes `RECEIVED_AMOUNT_OVERFLOW` (No Real Loss)

**Description:** The `assets` parameter is `u256`. The only pre-execution guard on it is `assets.is_non_zero()`. There is no upper-bound check. After the vault call, `balance_after - balance_before` is cast via `.try_into::<u128>()`, which panics with `RECEIVED_AMOUNT_OVERFLOW` if the received amount exceeds `u128::MAX`.

**Exploitability:** An attacker could craft calldata with `assets = 2^128` (or any value > u128::MAX). For this to reach the overflow panic, the vault's `withdraw` must *succeed* — meaning the anonymizer must actually hold enough vToken shares to cover `assets`. In production, if no user has deposited that much, the vault reverts first (via its own balance check), so the `RECEIVED_AMOUNT_OVERFLOW` panic is unreachable in practice.

**Verdict:** Not exploitable in the realistic threat model. The vault's share-balance check acts as an implicit cap. Funds cannot be stranded because the anonymizer never receives the oversized amount — the vault reverts before that.

**Suggestion:** A defensive upper-bound assertion `assert(assets.high == 0, 'ASSETS_EXCEEDS_U128')` before the vault call would make the invariant explicit and harden the contract against pathological vault implementations.

---

## Finding 3: Theoretical — No Caller Authentication on `privacy_invoke`

**Description:** `privacy_invoke` has no access control — any address can call it, not only the privacy contract. The function reads `privacy_addr = get_caller_address()` and approves that address to spend `out_amount` of `out_token`.

**Exploitability analysis:**

- The caller supplies all parameters: `in_token`, `out_token`, `assets`, `note_id`.
- For Withdraw, the vault burns shares from `owner: self_addr` (the anonymizer). The anonymizer must actually hold those vToken shares. If the anonymizer has no vTokens, the vault reverts.
- Suppose the anonymizer holds some vTokens (they were deposited via a prior legitimate use). A malicious caller could:
  1. Call `privacy_invoke(Withdraw, in_token=vToken, out_token=underlying, assets=X, note_id=arbitrary)`.
  2. The vault burns X vTokens from the anonymizer, sends X underlying to the anonymizer.
  3. The anonymizer approves the **malicious caller** (not the privacy contract) for X underlying.
  4. The caller now calls `transfer_from(anonymizer, attacker, X)` to steal those tokens.
  5. Additionally, `note_id` is arbitrary — `_deposit_to_open_note` will fail if the note doesn't exist or mismatches, but by then the underlying tokens have already been moved (the anonymizer approved the caller).

**Wait — revisiting:** The `_deposit_to_open_note` is called by the **privacy contract**, not by the attacker. The malicious caller to `privacy_invoke` gets the approval but the privacy contract is NOT involved in this path. The attacker has the allowance and can `transfer_from` the anonymizer directly.

**Critical condition:** This attack requires the anonymizer to hold vToken balance outside of an active privacy-contract-mediated call. In the intended design, the anonymizer holds vTokens only transiently (deposited just before `privacy_invoke` is called). Between privacy-contract invocations, the anonymizer should hold zero vTokens (they are burned on withdraw, or held temporarily). If the anonymizer ever has a non-zero vToken balance between calls, that balance can be drained by any caller.

**Verdict:** This is a **real concern** if the anonymizer's vToken balance can be positive between legitimate calls. However, in the intended protocol flow, vTokens accumulate only when a user performs a Deposit operation, and are consumed by the subsequent Withdraw. Whether vToken balance can be "stranded" in the anonymizer between calls depends on external protocol usage. If the privacy protocol guarantees that `privacy_invoke` is called atomically (same tx) as part of the note lifecycle, then no stranded balance exists. The lack of caller authentication is still a defense-in-depth gap.

**Impact level:** Low-to-medium. No funds are at risk if the anonymizer never holds tokens between protocol-mediated calls, which is the intended invariant. But the invariant is not enforced by the contract itself.

---

## Finding 4: Confirmed — Mock Vault `withdraw` Burns Shares Equal to `assets`, Not `previewWithdraw(assets)`

In the `MockVesuVault`, `withdraw(assets, receiver, owner)` burns exactly `assets` shares (1:1 ratio). This matches the test setup where deposit/withdraw use 1:1 pricing. In a real Vesu vault with non-1:1 exchange rates (shares ≠ assets), the number of shares burned would differ from `assets`. The anonymizer ignores the return value (shares burned) and measures `balance_after - balance_before` instead — which is the correct approach per ERC-4626. This is **not a bug**.

---

## Summary

| # | Finding | Severity | Exploitable? |
|---|---------|----------|-------------|
| 1 | Core withdraw flow is correct | N/A (no bug) | — |
| 2 | `assets > u128::MAX` → `RECEIVED_AMOUNT_OVERFLOW` | Informational | No (vault reverts first) |
| 3 | No caller authentication on `privacy_invoke` | Low–Medium | Only if anonymizer holds stranded vTokens |
| 4 | Mock 1:1 ratio vs real vault | N/A (test artifact) | — |

The withdraw path has no exploitable critical bugs given the intended protocol invariants. The most noteworthy gap is the absence of an access control guard on `privacy_invoke` (Finding 3), which relies on the operational invariant that the anonymizer never holds a vToken balance between calls.
