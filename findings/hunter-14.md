# Bug Hunter #14 — Interface Consistency: Privacy Contract ↔ Anonymizers

## Scope

Focus: interface consistency between the privacy contract and the anonymizers — what data is shared, how note IDs work, and semantic mismatches.

Key files reviewed:
- `packages/privacy/src/objects.cairo` — `OpenNoteDeposit` struct
- `packages/privacy/src/hashes.cairo` — `compute_note_id`
- `packages/privacy/src/privacy.cairo` lines 800–975 — `_apply_actions`, `_apply_invoke`, `_deposit_to_open_note`
- `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`
- `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo`
- `packages/privacy/src/interface.cairo`

---

## Finding 1 — MEDIUM: Vesu Withdraw Strands Excess vTokens in Anonymizer (No Recovery Path)

**Location:** `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo:157-161`

**Severity:** Medium — funds can become permanently locked in the anonymizer with no recovery mechanism.

### Description

In the Vesu Withdraw flow, the user sends exactly `shares` of vToken from the privacy contract to the anonymizer via `Withdraw { to_addr: anonymizer, token: vToken, amount: shares }`. The anonymizer then calls:

```cairo
IVTokenDispatcher { contract_address: in_token }
    .withdraw(:assets, receiver: self_addr, owner: self_addr)
```

The ERC-4626 `withdraw(assets, receiver, owner)` function burns the minimum number of shares required to withdraw exactly `assets` of underlying. If the user sent **more shares than needed** to redeem `assets` of underlying (i.e., the shares sent correspond to MORE underlying than `assets`), the surplus shares remain in the anonymizer with no mechanism to retrieve them.

There is no admin withdrawal function, no sweep mechanism, and no storage in the anonymizer. The anonymizer is a pure stateless contract with no owner or recovery path.

**When can excess shares arise?**
- The share price of a Vesu vault changes block-to-block as interest accrues.
- The user computes "how many shares to send" off-chain at block T, then the transaction executes at block T+N. In that time, the share price increased (1 share = more underlying than before). So sending `shares` at T+N burns fewer shares than `shares` to withdraw `assets`, leaving `excess_shares = shares - burned_shares` stranded.

**Proof of impact:**
- `shares` are sent to the anonymizer via `TransferTo` (a `Withdraw` server action).
- The anonymizer calls `withdraw(assets, ...)` which burns `burned_shares < shares`.
- The remaining `shares - burned_shares` vTokens stay in the anonymizer.
- The anonymizer has no function to transfer these out.
- No event is emitted; the excess is silent.

**Note:** The anonymizer does measure `balance_after - balance_before` for the output token (underlying), so the deposit amount is computed correctly from actual received underlying. The bug is purely about the remaining input token (vTokens), not the output.

**Mitigation:** After calling `withdraw`, transfer any remaining `in_token` balance back to `privacy_addr` (the privacy contract), or return the remainder as a second `OpenNoteDeposit` in the span (if a vToken open note exists), or assert that the entire `in_token` balance was consumed. The simplest fix is to return any excess `in_token` back to the caller after the vault operation.

---

## Finding 2 — LOW: `note_id` from Anonymizer is User-Controlled with No Commitment Binding

**Location:** Both anonymizers, and `packages/privacy/src/privacy.cairo:947`

**Severity:** Low — by design the user provides `note_id`, but the binding is asymmetric.

### Description

The `note_id` appearing in `OpenNoteDeposit` is passed verbatim from the user's calldata through to the anonymizer and back. The privacy contract verifies that the `note_id` belongs to a valid open note for the correct token (via the `NOTE_NOT_FOUND`, `NOTE_NOT_OPEN`, `TOKEN_MISMATCH` checks). However, the `note_id` itself is not committed anywhere in the zero-knowledge proof or verified against the anonymizer's behavior — it is pure user input propagated through the calldata.

**Consequence:** A user can specify any `note_id` in calldata. The privacy contract's defenses mean this only affects the user's own transaction:
- If `note_id` doesn't exist → `NOTE_NOT_FOUND`, tx reverts.
- If `note_id` is an encrypted note → `NOTE_NOT_OPEN`, tx reverts.
- If `note_id` open note has a mismatched token → `TOKEN_MISMATCH`, tx reverts.

The user cannot direct funds to another user's open note because only the creator of an open note knows its `note_id` (derived from `h(NOTE_ID_TAG, channel_key, token, index, 0)` using a private `channel_key`). This is safe under the assumption that `note_id` space collisions are infeasible.

**Assessment:** No exploitable vulnerability — reverts protect all invalid cases. Documented here for completeness.

---

## Finding 3 — INFORMATIONAL: `undeposited_open_notes` Counter Allows Invoke to Deposit to Fewer Notes Than Created

**Location:** `packages/privacy/src/privacy.cairo:804,842,851,857`

**Severity:** Informational — the constraint is correctly enforced; the note is here for clarity.

### Description

The `undeposited_open_notes` counter in `_apply_actions` tracks that every `EmitOpenNoteCreated` action is matched by an `Invoke` return that deposits to one note. The counter is:
- Incremented by 1 on each `EmitOpenNoteCreated`.
- Decremented by `open_note_deposits.len()` on each `Invoke`.
- Must be zero at the end.

This means:
1. An `Invoke` can return 0 deposits (valid only if 0 open notes were created).
2. An `Invoke` returning N deposits must match exactly N `EmitOpenNoteCreated` actions.
3. Two `Invoke` actions are not structurally prevented; but `InvokeExternal` is limited to one per transaction (enforced in the client action phase, `ClientActionTrait::INVOKE_PHASE`).

The `TOO_MANY_OPEN_NOTES_DEPOSITED` via `checked_sub` prevents the Invoke from depositing to MORE notes than were created. This is correct.

**Assessment:** No bug. The counter logic is sound.

---

## Finding 4 — INFORMATIONAL: Ekubo Anonymizer Does Not Validate That Caller is the Privacy Contract

**Location:** `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo:127` (and Vesu equivalent at line 141)

**Severity:** Informational — the design is intentional and safe given the approve mechanism.

### Description

Both anonymizers call `get_caller_address()` and use the result as `privacy_addr` to set the ERC20 allowance:
```cairo
let privacy_addr = get_caller_address();
// ...
out_erc20.approve(spender: privacy_addr, amount: out_amount.into());
```

There is no assertion that `privacy_addr` is the actual privacy contract. Any address can call `privacy_invoke` directly. If a non-privacy-contract caller triggers the function:
- The anonymizer performs the swap/lending operation.
- It approves the caller (not the privacy contract) to spend the output tokens.
- The caller can then transfer the output tokens to themselves.

For the Ekubo anonymizer this means anyone can trigger a swap against the anonymizer's input token balance and then drain the output. However, the anonymizer has no persistent input token balance — tokens only arrive via a `TransferTo` action in the same transaction. So in practice the risk requires the caller to frontrun the privacy contract's `apply_actions`.

**Assessment:** Design tradeoff — the anonymizer is intentionally permissionless. Since it has no persistent state and no stored funds between transactions, the attack surface is limited to griefing or frontrunning specific transactions. Not a standalone exploitable bug but worth noting in the threat model.

---

## Finding 5 — INFORMATIONAL: Ekubo `clear_minimum` Return Value Silently Ignored

**Location:** `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo:147-150`

```cairo
// Ignore the return value of clear_minimum. We calculate the output amount
// below.
let balance_before = out_erc20.balance_of(account: self_addr);
clear
    .clear_minimum(
        token: EkuboIERC20Dispatcher { contract_address: out_token },
        minimum: minimum_received,
    );
```

The comment acknowledges that `clear_minimum`'s return value is ignored, and the actual output is measured via `balance_after - balance_before`. This is correct because `clear_minimum` sends the output to `self_addr` and the balance delta captures it precisely. Slippage protection is enforced by the `minimum_received` parameter to `clear_minimum` itself (which reverts if the amount is below minimum).

**Assessment:** No bug; the comment explains the design intent correctly.

---

## Summary

| # | Severity | Finding |
|---|----------|---------|
| 1 | **MEDIUM** | Vesu Withdraw strands excess vTokens in anonymizer with no recovery path |
| 2 | Low | `note_id` is user-controlled (safe by construction, but no proof-binding) |
| 3 | Informational | `undeposited_open_notes` counter semantics |
| 4 | Informational | Neither anonymizer validates caller is privacy contract |
| 5 | Informational | Ekubo `clear_minimum` return value intentionally ignored |

The most significant finding is **Finding 1**: when a Vesu vault's share price has increased between proof generation and execution, excess vTokens accumulate in the stateless anonymizer with no mechanism for recovery.
