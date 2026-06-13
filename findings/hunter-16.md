# Bug Hunter #16 — Cross-Contract Consistency Findings

**Investigation Area:** Cross-contract consistency between anonymizer contracts and the privacy contract's interface expectations.

**Key files examined:**
- `packages/privacy/src/privacy.cairo` — `_apply_invoke`, `_deposit_to_open_note`, `_apply_actions`
- `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`
- `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo`
- `packages/privacy/src/tests/test_ekubo_swap_anonymizer.cairo`
- `packages/vesu_lending_anonymizer/src/tests/test_vesu_lending_anonymizer.cairo`
- `packages/privacy/src/interface.cairo`
- `packages/privacy/src/objects.cairo`
- `packages/privacy/src/actions.cairo`
- `packages/privacy/src/errors.cairo`

---

## Bug 1 — `DEPOSITOR_BLOCKED` check skipped when anonymizer returns 0 deposits

**Classification: Real bug**

**File:** `packages/privacy/src/privacy.cairo`, lines 798–816

```cairo
ServerAction::Invoke(input) => {
    let open_note_deposits = self._apply_invoke(:input);  // anonymizer executes here
    if !open_note_deposits.is_empty() {                   // check is conditional
        let open_note_depositor = input.contract_address;
        assert(
            !self.blocked_depositors.read(open_note_depositor),
            errors::DEPOSITOR_BLOCKED,
        );
        for deposit in open_note_deposits { ... }
    }
    undeposited_open_notes = undeposited_open_notes
        .checked_sub(open_note_deposits.len())
        ...
```

The `DEPOSITOR_BLOCKED` check is gated behind `if !open_note_deposits.is_empty()`. If a blocked anonymizer contract is invoked and returns an empty span (`[]`), the check is never reached. The anonymizer's full execution (`_apply_invoke`) already ran, including any DeFi operations (Ekubo swap, Vesu deposit/withdraw) or arbitrary side-effects.

**Consequence:** A blocked anonymizer that is crafted to return zero deposits will:
1. Execute all internal logic (any ERC20 transfers, vault interactions, etc.) without triggering `DEPOSITOR_BLOCKED`.
2. Not deposit to any open note, and `undeposited_open_notes` is decremented by 0.
3. If there are no `EmitOpenNoteCreated` events in the same transaction, `undeposited_open_notes` stays at 0 and the final check passes.

**Impact:** If `set_depositor_blocked` is intended to prevent invocation of the contract (not just to prevent deposits), then a blocked anonymizer can be called successfully by returning an empty list. Whether this is a bug depends on intent: the interface doc at `interface.cairo:810–812` says "a blocked depositor cannot fund any open note" — this implies the intended restriction is on depositing, not on invoking. However, blocking invocation would be the stronger guarantee.

**Recommendation:** If the intent is to block all execution of a blocked anonymizer, move the check before `_apply_invoke`:

```cairo
let open_note_depositor = input.contract_address;
assert(
    !self.blocked_depositors.read(open_note_depositor),
    errors::DEPOSITOR_BLOCKED,
);
let open_note_deposits = self._apply_invoke(:input);
```

If the intent is only to block deposits, document this explicitly so operators are not misled into thinking blocking prevents invocation.

---

## Bug 2 — `DEPOSITOR_BLOCKED` targets the anonymizer contract address, not the user

**Classification: Design choice with operational consequence — worth documenting clearly**

**File:** `packages/privacy/src/privacy.cairo`, lines 801–804 and `_deposit_to_open_note` lines 885–914

The `depositor` used in both the block check and in `checked_transfer_from` is always `input.contract_address` — the anonymizer contract's address.

**Findings:**

1. **Blocking a specific user is impossible.** All users of a given anonymizer contract share its address. Blocking the anonymizer blocks everyone using it, not one user.

2. **Bypass via new deployment is trivial.** Both `EkuboSwapAnonymizer` and `VesuLendingAnonymizer` are stateless (empty `Storage` structs, no constructor parameters that bind to any identity). Anyone can deploy a bytecode-identical anonymizer at a new address. Blocking `anonymizer_A` provides no protection against a fresh `anonymizer_B` deployment with identical class hash.

   ```cairo
   // From ekubo_swap_anonymizer.cairo:
   #[storage]
   struct Storage {}
   
   #[constructor]
   fn constructor(ref self: ContractState) {}
   ```

3. **The block is coarse-grained by design.** The stated purpose (blocking a known-bad anonymizer contract, e.g., one with a vulnerability) is achievable. Per-user blocking is not achievable.

**Impact:** Operators must understand that `set_depositor_blocked(addr, true)` blocks a specific deployed contract instance, not a user. A determined user can simply redeploy an equivalent anonymizer and continue using it.

**Recommendation:** Document explicitly in `set_depositor_blocked` that the blocked entity is an anonymizer contract address, and that blocking does not prevent a user from deploying a new anonymizer. If per-user blocking is ever needed, a different mechanism (e.g., binding user address into calldata and enforcing it in the privacy contract) would be required.

---

## Bug 3 — Dead error constant `MULTIPLE_DEPOSITORS` signals incomplete design

**Classification: Code quality / incomplete implementation**

**File:** `packages/privacy/src/errors.cairo`, line 54

```cairo
pub const MULTIPLE_DEPOSITORS: felt252 = 'MULTIPLE_DEPOSITORS';
```

This constant is defined but never referenced anywhere in the codebase (confirmed by full-codebase search: zero references outside `errors.cairo`).

**Analysis:** The constant suggests a prior or intended design that enforced at most one depositor address per `apply_actions` call. That constraint is absent. Currently, a transaction could include multiple `Invoke` server actions (each from a different anonymizer address), each with their own blocked-status check. There is no enforcement that all deposits in a transaction come from the same anonymizer contract.

Although `InvokeExternal` is limited to at most one per transaction at the client-compilation level (via `assert_and_advance_phase` which advances `INVOKE_PHASE` past itself after one `InvokeExternal`), the server-side `apply_actions` imposes no such constraint. A server could theoretically submit multiple `Invoke` actions. The dead constant suggests this was once the enforcement point.

**Recommendation:** Either remove `MULTIPLE_DEPOSITORS` from `errors.cairo` if the single-depositor-per-tx invariant is intentionally dropped, or reimplement the enforcement if it is still desired. The current state (defined but unused) creates confusion.

---

## Bug 4 — Cross-transaction open note deposits: correctly protected by invariant (non-issue with subtle reasoning)

**Classification: Non-issue, but the safety relies on a non-obvious invariant that should be documented**

**Analysis:**

The `_deposit_to_open_note` function does not verify that the deposited `note_id` was created in the *current* transaction. An anonymizer receives `note_id` from user-supplied calldata and could in principle return a `note_id` for a note created in a prior transaction.

The counter check in `_apply_actions` only enforces: `(count of EmitOpenNoteCreated) == (count of Invoke deposits)`. It does NOT enforce identity — that deposits target the specific notes emitted in this transaction.

However, the vulnerability is blocked by `_deposit_to_open_note` line 899:

```cairo
assert(current_amount.is_zero(), errors::NOTE_ALREADY_DEPOSITED);
```

**Why this is safe:** Every successfully stored open note has a non-zero amount. This is because:
- An open note is created via `WriteOnce` with `packed_value = OPEN_NOTE_PACKED_VALUE = pack(OPEN_NOTE_SALT, 0)` (amount = 0).
- The same transaction that creates the note MUST also deposit to it (enforced by `UNDEPOSITED_OPEN_NOTES`).
- Depositing sets the amount to non-zero.
- Therefore, any open note in persistent storage after a successful transaction has amount != 0.

An anonymizer returning a stale `note_id` from a prior transaction would hit `NOTE_ALREADY_DEPOSITED` and revert. There is no exploitable window.

**Remaining concern:** The safety relies on the coupling between `EmitOpenNoteCreated` and `UNDEPOSITED_OPEN_NOTES`. If a future refactor breaks this coupling (e.g., allowing open notes to be created without same-transaction deposit), the cross-tx vulnerability would open. This reasoning should be captured as a code comment.

**Recommendation:** Add a comment in `_deposit_to_open_note` explaining: "The `current_amount.is_zero()` check implicitly prevents cross-transaction note targeting because any open note in persistent storage was deposited in the same transaction it was created (enforced by `UNDEPOSITED_OPEN_NOTES`)."

---

## Bug 5 — User-controlled `note_id` in anonymizer calldata (non-issue, correct by design)

**Classification: Non-issue**

Both anonymizers receive `note_id` as a parameter from user-supplied calldata:

```cairo
// Ekubo:
fn privacy_invoke(ref self: T, ..., note_id: felt252) -> Span<OpenNoteDeposit>

// Vesu:
fn privacy_invoke(ref self: T, ..., note_id: felt252) -> Span<OpenNoteDeposit>
```

Both pass it unchanged to `OpenNoteDeposit { note_id, token: out_token, amount: out_amount }`.

The privacy contract validates `note_id` at runtime in `_deposit_to_open_note`: checks existence, open status, undeposited state, and token match. If the user provides a wrong `note_id`, the transaction reverts with `NOTE_NOT_FOUND`, `NOTE_NOT_OPEN`, `NOTE_ALREADY_DEPOSITED`, or `TOKEN_MISMATCH`.

The anonymizer has no independent way to know which note to deposit to — it must be told by the user who knows the note structure. This is correct design.

---

## Bug 6 — Returning zero deposits when no open note was created (non-issue)

**Classification: Non-issue**

If an anonymizer returns an empty span and no `EmitOpenNoteCreated` was in the same transaction, `undeposited_open_notes` stays at 0 and the final check passes. The `Invoke` without deposits is valid in that context.

If a `CreateOpenNote` was also in the transaction, `undeposited_open_notes` = 1, and zero deposits means the final check (`undeposited_open_notes == 0`) fails with `UNDEPOSITED_OPEN_NOTES`. This correctly rejects such transactions.

---

## Bug 7 — Token flow: privacy contract does not send tokens to the anonymizer before invoking it

**Classification: Non-issue, design clarification useful**

`_apply_invoke` (lines 870–881) only calls `call_contract_syscall`. No tokens are sent beforehand. The anonymizer must already hold input tokens.

**How the anonymizer gets funded in valid flows:**

The `Withdraw` client action (phase 6) compiles to `ServerAction::TransferTo { to_addr, token, amount }`. When a user sets `to_addr = anonymizer_address`, the `_apply_transfer_to` action executes before `_apply_invoke` (since `TransferTo` actions precede `Invoke` in `apply_actions` processing order, because actions are processed in sequence and `Withdraw` is phase 6 while `InvokeExternal` is phase 7).

The expected legitimate flow:
```
UseNote (phase 4) → [internal balance credit]
CreateOpenNote (phase 5) → [note written to storage]
Withdraw (phase 6) → TransferTo(anonymizer, token, amount) → anonymizer now has funds
InvokeExternal (phase 7) → Invoke(anonymizer, calldata) → swap → approve privacy contract
```

Tests (`test_ekubo_privacy_invoke_via_privacy_contract`) demonstrate this by pre-funding the anonymizer directly (bypassing the Withdraw step) to keep test setup simple.

**Confirmation:** `_apply_transfer_to` uses `checked_transfer` which sends tokens from the privacy contract. Since actions are processed in the order they appear in the `actions` span, and the span is built from client actions in phase order, the `TransferTo` from `Withdraw` always executes before the `Invoke` from `InvokeExternal`. Correct design.

---

## Bug 8 — Approval race / residual balance in anonymizer: no bug for standard ERC20s

**Classification: Non-issue for standard tokens; informational for non-standard tokens**

Both anonymizers use balance-delta to compute `out_amount` and approve exactly that amount:

```cairo
// Ekubo (lines 146–159):
let balance_before = out_erc20.balance_of(account: self_addr);
clear.clear_minimum(...);
let balance_after = out_erc20.balance_of(account: self_addr);
let out_amount: u128 = (balance_after - balance_before).try_into()...;
out_erc20.approve(spender: privacy_addr, amount: out_amount.into());
```

**Pre-existing balance:** If the anonymizer already holds some `out_token` before the swap, `balance_before` captures it, and `out_amount` is only the NEW tokens received. The approval is set to exactly what was received. `_deposit_to_open_note` then pulls exactly `out_amount`. Correct.

**Fee-on-transfer ERC20s:** If `out_token` deducts a fee on transfer (so `balance_after - balance_before < actual_received`), the arithmetic is still correct — the delta reflects what the anonymizer actually holds. The approval and deposit amounts match. However, the Ekubo `clear_minimum` check would receive fewer tokens than the swap output, which might trigger its minimum check. Not a privacy contract bug.

**Approval atomicity:** If `_deposit_to_open_note` reverts after the approval is set, the full transaction reverts (StarkNet atomicity), rolling back the approval. No leftover approval.

**Conclusion:** No bug for standard tokens. Fee-on-transfer behavior is handled consistently (may cause legitimate reverts from slippage checks, but not silent loss).

---

## Summary Table

| # | Finding | Classification | Severity | Actionable |
|---|---------|----------------|----------|------------|
| 1 | `DEPOSITOR_BLOCKED` skipped when anonymizer returns 0 deposits | Real bug | Medium | Yes — move check before `_apply_invoke` if invocation-blocking is intended |
| 2 | Block targets anonymizer contract, not user; bypass via redeployment | Design limitation | Medium | Document clearly; no code fix unless per-user blocking is desired |
| 3 | Dead `MULTIPLE_DEPOSITORS` constant | Code quality | Low | Remove or implement |
| 4 | Cross-tx open note deposit: protected by `NOTE_ALREADY_DEPOSITED` invariant | Non-issue with subtle reasoning | Informational | Add comment documenting invariant |
| 5 | User-controlled `note_id` | Non-issue (correct design) | N/A | — |
| 6 | Zero deposits when no open note: correct revert | Non-issue | N/A | — |
| 7 | Token flow relies on prior `TransferTo` in same tx | Non-issue (correct design) | Informational | Document expected flow in comments |
| 8 | Approval race / residual balance | Non-issue for standard tokens | Informational | — |

---

## Priority Findings

**Finding 1** is the highest-priority actionable item. The `DEPOSITOR_BLOCKED` guard can be bypassed by returning an empty deposit list. Whether this is a real bug depends on whether the contract intends to block invocation (stronger) or only block deposits (weaker). The interface docs say "cannot fund any open note" — consistent with the weaker interpretation — but this should be confirmed with the design team and explicitly documented.

**Finding 2** has no code fix (it is a design property of the blocking mechanism), but the documentation must clearly state that blocking an anonymizer address does not prevent a user from redeploying an equivalent anonymizer.

**Finding 3** (`MULTIPLE_DEPOSITORS` dead code) should be resolved to remove ambiguity about the design intent.
