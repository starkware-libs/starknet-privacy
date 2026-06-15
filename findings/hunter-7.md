# Bug Hunter #7 Findings — `invoke_external`, `apply_actions`, and open notes

Focus area: `invoke_external` client action, server-side `apply_actions` / `_apply_actions` / `_apply_invoke`, and the interaction between `Invoke` server actions and `undeposited_open_notes` accounting.

---

## Finding 1: Self-invocation of privacy contract via `_apply_invoke` — safe (confirmed non-issue)

**Severity: None (confirmed safe)**

**File:** `packages/privacy/src/privacy.cairo`, lines 929–939; `packages/privacy/src/tests/test_server.cairo`, lines 1171–1175

**Description:**

`_apply_invoke` calls `call_contract_syscall(address: contract_address, entry_point_selector: INVOKE_SELECTOR, ...)` with no guard preventing `contract_address == get_contract_address()`. A user could submit `InvokeExternalInput { contract_address: <privacy_contract_address>, calldata: ... }` and the server would faithfully produce a `ServerAction::Invoke` pointing at itself.

**Analysis:** The privacy contract does not expose a `privacy_invoke` entrypoint (its ABI implements `IClient`, `IServer`, `IAdmin`, `IViews`, and OpenZeppelin components — none of which has a `privacy_invoke` selector). The Starknet OS will return `ENTRYPOINT_NOT_FOUND` for any `call_contract_syscall` to the privacy address with `INVOKE_SELECTOR`, and `.unwrap_syscall()` will panic, reverting the whole transaction. This is confirmed by the existing test at `test_server.cairo:1171–1175`.

No state changes occur, and there is no re-entrancy risk. The behavior is safe.

---

## Finding 2: Re-entrancy guard correctly prevents `apply_actions` callback from `_apply_invoke` — confirmed non-issue

**Severity: None (confirmed safe)**

**File:** `packages/privacy/src/privacy.cairo`, lines 740–746; `packages/privacy/src/tests/mock_reentrancy.cairo`

**Description:**

The re-entrancy guard is started at `apply_actions` line 740 before `_apply_actions` is called, and ends at line 746 after it returns. If an external contract invoked via `_apply_invoke` attempts a re-entrant call to `apply_actions`, the OpenZeppelin `ReentrancyGuardComponent` fires.

**Analysis:** `mock_reentrancy.cairo` is the test harness for exactly this scenario: a `privacy_invoke` implementation that calls `IServerDispatcher { ... }.apply_actions([].span(), Option::None)` back on the privacy contract. The test at `test_server.cairo` (around line 660–665) confirms this rejects with the re-entrancy guard error. The guard is correctly applied.

Similarly, the guard is active during `__execute__` (line 192), which calls `compile_actions` (which calls `compile_and_panic` via syscall). Any re-entrant attempt into `__execute__` or `apply_actions` during the compile phase is also blocked.

---

## Finding 3: `_deposit_to_open_note` executes before `checked_sub` — state changes occur before potential panic, but Cairo reverts all of them

**Severity: None (confirmed safe, but subtle)**

**File:** `packages/privacy/src/privacy.cairo`, lines 824–844

**Description:**

In the `ServerAction::Invoke` arm of `_apply_actions`:

```cairo
ServerAction::Invoke(input) => {
    let open_note_deposits = self._apply_invoke(:input);
    if !open_note_deposits.is_empty() {
        // ...blocked check...
        for deposit in open_note_deposits {
            self._deposit_to_open_note(depositor: open_note_depositor, deposit: *deposit);
            // ^^^ State written, ERC20 transferFrom called HERE
        }
    }
    undeposited_open_notes = undeposited_open_notes
        .checked_sub(open_note_deposits.len())
        .expect(internal_errors::TOO_MANY_OPEN_NOTES_DEPOSITED);
    // ^^^ Panic AFTER deposits if open_note_deposits.len() > undeposited_open_notes
},
```

If an anonymizer returns more deposits than open notes were created in the same `apply_actions` call, all ERC20 `transferFrom` calls and note storage writes happen BEFORE `checked_sub` panics.

**Why this is still safe:** In Cairo/Starknet, a `panic` aborts execution and the Starknet OS reverts ALL state changes made during the transaction — including ERC20 transfers and storage writes. There is no partial-commit model. So even though `_deposit_to_open_note` runs first, its effects are atomically undone when `checked_sub` panics.

**Confirmation:** The test `test_undeposited_open_notes` at line 1562 in `test_server.cairo` covers the `TOO_MANY_OPEN_NOTES_DEPOSITED` path: an Invoke that returns one deposit when zero open notes were created in the tx panics with the expected error, and token balances are confirmed unchanged afterward.

**Note for auditors:** This ordering is fragile from a reasoning standpoint. If Cairo ever introduced partial-commit semantics (e.g., a future `try/catch`-style mechanism), this code would have a real bug. It is worth documenting explicitly that the safety of running `_deposit_to_open_note` before `checked_sub` relies on Cairo's all-or-nothing panic semantics.

---

## Finding 4: `undeposited_open_notes` counter is transaction-scoped — deposits for pre-existing open notes trigger `TOO_MANY_OPEN_NOTES_DEPOSITED` panic (intended behavior, but the error message is misleading)

**Severity: Informational**

**File:** `packages/privacy/src/privacy.cairo`, lines 804, 842–844, 851; `packages/privacy/src/errors.cairo`, line 72

**Description:**

`undeposited_open_notes` is initialized to `0` at the start of `_apply_actions` and incremented only when an `EmitOpenNoteCreated` server action is processed in the **same** `apply_actions` call. The counter is then decremented by the number of deposits returned by each `Invoke` action.

If an anonymizer's `privacy_invoke` returns a deposit pointing at an open note that was created in a **prior** transaction (i.e., a pre-existing undeposited open note from the contract's storage), `undeposited_open_notes` is still 0 at decrement time, `checked_sub` underflows, and the transaction panics with `TOO_MANY_OPEN_NOTES_DEPOSITED`.

**Impact on intended use cases:** This design means that the only supported pattern is: create open note + deposit to it in the **same** `apply_actions` call. An anonymizer cannot be used to fund a note that was created in a previous block. This is a design constraint, not a bug, but it is not documented in the interface or the `InvokeExternal` action documentation.

**Error message quality:** The panic message `TOO_MANY_OPEN_NOTES_DEPOSITED` is confusing in this scenario. An anonymizer returning a single deposit for a pre-existing note is told "too many open notes deposited" — but the real problem is that there were zero open notes created in this transaction, not that too many deposits were attempted. A more accurate message would distinguish between `INVOKE_DEPOSIT_WITHOUT_MATCHING_CREATE` and the actual overflow case.

**Recommended fix:** Either document the constraint explicitly (same-tx create + deposit is required) in the `IClient.invoke_external` and `ServerAction::Invoke` doc comments, or improve the error message to give actionable feedback.

---

## Finding 5: Multiple `ServerAction::Invoke` entries are not restricted at the server layer — `undeposited_open_notes` arithmetic is unbounded

**Severity: Informational / Low**

**File:** `packages/privacy/src/privacy.cairo`, lines 803–857; `packages/privacy/src/actions.cairo`, lines 276–286

**Description:**

At the **client** layer, `assert_and_advance_phase` enforces that `InvokeExternal` is used at most once per transaction (its phase is `7`, and once used, `curr_phase` advances to `8`, making any subsequent `InvokeExternal` fail with `ACTIONS_OUT_OF_ORDER`).

At the **server** layer, `apply_actions` accepts a raw `Span<ServerAction>` with no restriction on the number of `Invoke` entries. The `validate_proof` function hashes the entire action span and checks it against the L1 message — so a proof can only be valid for the exact action list it was generated for. This means that in production, a multi-`Invoke` action list can only appear if the proof system itself (STARK prover for the privacy circuit) generates it.

**The accounting logic** in `_apply_actions` does handle multiple `Invoke` entries correctly: each one decrements `undeposited_open_notes` by the number of deposits it returns, and the final `assert(undeposited_open_notes == 0)` enforces balance across all invokes. However, there is no upper bound on the total number of deposits an anonymizer can claim (i.e., no `MAX_DEPOSITS_PER_INVOKE` cap).

**Realistic attack surface:** Because `validate_proof` ties the action list to a valid proof, the server can't be fed an arbitrary multi-Invoke list by a user in production. The risk is theoretical unless:
- The STARK circuit itself allows multiple invokes (unknown from Cairo source alone), or
- A future change removes or weakens the proof check (e.g., for testing purposes in a staging environment where `validate_proof` is skipped).

**Recommended fix:** Add a `MAX_OPEN_NOTE_DEPOSITS_PER_INVOKE: usize` constant and assert it in `_apply_invoke` or immediately after the call, to cap how many deposits a single anonymizer can return. This is a defense-in-depth measure.

---

## Finding 6: `InvokeExternalInput.assert_valid` does not validate calldata length — arbitrary calldata permitted

**Severity: Informational**

**File:** `packages/privacy/src/actions.cairo`, lines 214–218

**Description:**

```cairo
pub(crate) impl InvokeExternalInputValid of InputValidation<InvokeExternalInput> {
    fn assert_valid(self: InvokeExternalInput) {
        let InvokeExternalInput { contract_address, calldata: _ } = self;
        assert(contract_address.is_non_zero(), errors::ZERO_CONTRACT_ADDRESS);
    }
}
```

The `calldata` field is entirely ignored in validation. A user can submit an `InvokeExternal` action with arbitrarily long calldata. This calldata:
1. Is included in the server action `Span<felt252>` passed to `call_contract_syscall`, and
2. Is serialized as part of the L1 message (via `send_message_to_server`), which hashes it into the proof commitment.

**Impact:** No gas-griefing is possible at the contract level since StarkNet charges gas for calldata. No state corruption is possible since the calldata only affects the external anonymizer contract's behavior. However, there is no documented upper bound on calldata size, which could have implications for:
- Maximum L1 message payload size (if the message send has a limit).
- Off-chain proof system assumptions about action serialization size.

**Recommended fix:** Document or enforce a maximum calldata length (e.g., `const MAX_INVOKE_CALLDATA_LEN: usize = 256`) if the proof system or L1 message infrastructure has any length constraints. If not, document explicitly that calldata length is unbounded.

---

## Summary Table

| # | Title | Severity |
|---|-------|----------|
| 1 | Self-invocation of privacy contract via `_apply_invoke` | None (safe) |
| 2 | Re-entrancy guard covers `_apply_invoke` callback | None (safe) |
| 3 | `_deposit_to_open_note` before `checked_sub` — depends on Cairo panic semantics | None (safe, but fragile reasoning) |
| 4 | `undeposited_open_notes` is transaction-scoped; cross-tx deposits impossible; error message misleading | Informational |
| 5 | Multiple `Invoke` server actions not restricted at server layer; no per-invoke deposit cap | Informational / Low |
| 6 | `InvokeExternalInput` calldata is unchecked in length | Informational |
