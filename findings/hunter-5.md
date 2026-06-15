# Security Audit Findings — Hunter 5
## Contract: `packages/privacy/src/privacy.cairo`
## Focus: `deposit`, `withdraw`, `use_note`, `_apply_actions`

---

## Finding 1 (CONFIRMED BUG): Cross-Transaction Open Note Deposit — `TOO_MANY_OPEN_NOTES_DEPOSITED` DoS

**Severity:** High  
**Location:** `_apply_actions` (lines 824–857), `_deposit_to_open_note` (lines 944–974)

### Description

The `undeposited_open_notes` counter in `_apply_actions` tracks open notes created **within the current `apply_actions` call** using `EmitOpenNoteCreated` events. When an `Invoke` action returns `open_note_deposits`, the counter is decremented by `open_note_deposits.len()`. A final assert enforces the counter equals zero.

**The bug:** An anonymizer contract's `privacy_invoke` entrypoint is free to return any `note_id` values in its `OpenNoteDeposit` array. There is nothing in `_deposit_to_open_note` that restricts deposits to notes created in the **current** `apply_actions` call. The only check on the returned note is that it exists, is an open note, and has `current_amount == 0`.

If an anonymizer returns a deposit targeting an open note that was created in a **prior** transaction (still undeposited, `current_amount == 0`), `undeposited_open_notes` is decremented without a corresponding `EmitOpenNoteCreated` increment. This triggers a `checked_sub` underflow, which panics with `TOO_MANY_OPEN_NOTES_DEPOSITED`, reverting the entire transaction.

### Attack scenario

1. User A creates an open note (transaction T1). The anonymizer fails or is delayed and does not deposit in the same transaction. The note remains in storage with `amount = 0`.
2. In a later transaction T2, a user performs a legitimate operation that includes an `Invoke` action whose anonymizer naturally returns deposits for note IDs it computed. If the anonymizer's deposit list includes the stale open note from T1 (or a malicious actor controls the anonymizer and crafts its return value to include any undeposited note ID), the `Invoke` succeeds in depositing to the note but then `checked_sub(0, 1)` panics.

More critically, even in the non-malicious path: the design states that `CreateOpenNote` + `InvokeExternal` must always be in the same transaction. But if the proof validity window expires before the server applies the actions, the `apply_actions` call is never submitted. The open note then persists as permanently undepositable — it cannot be deposited in a subsequent transaction without triggering `TOO_MANY_OPEN_NOTES_DEPOSITED`.

This is confirmed by the test `test_undeposited_open_notes` (test_server.cairo, lines 1542–1578), which explicitly tests and asserts the `TOO_MANY_OPEN_NOTES_DEPOSITED` panic when an Invoke deposits to a note that was not created in the same `apply_actions` call.

### Root cause

`_deposit_to_open_note` has no way to know whether the note being deposited to was created in the current transaction or a prior one. The accounting counter (`undeposited_open_notes`) is purely local to the current `apply_actions` call.

### Impact

1. Open notes from failed/expired transactions are permanently locked — they cannot be rescued by a subsequent deposit, because any attempt will panic.
2. A malicious anonymizer that is unblocked can deposit to an old undeposited note, causing `TOO_MANY_OPEN_NOTES_DEPOSITED` to revert the whole transaction, blocking legitimate users from completing their operations.

### Recommended fix

One approach: store a transaction-bound tag alongside each open note (e.g., a nonce or block number when it was created) and require that `_deposit_to_open_note` only deposits to notes whose tag matches the current transaction. Alternatively, do not use a simple counter — instead track which specific note IDs were created in the current transaction and verify the deposit targets only those IDs.

---

## Finding 2 (CONFIRMED): Open Note Deposit Bypasses Screening — By Design but Under-documented

**Severity:** Low / Design note  
**Location:** `_apply_actions` lines 824–844, `_verify_screening` lines 861–889

### Description

`_verify_screening` is called only once at the end of `apply_actions` with the `depositor` value returned by `_apply_actions`. This `depositor` is set exclusively from `TransferFrom.from_addr`, i.e., regular-pool deposits. Open-note deposits (via `Invoke`) are screened only by the `blocked_depositors` denylist — there is no attestation check.

This means an anonymizer contract can deposit funds into the privacy pool via an open note without any screening attestation. A sanctioned entity that controls an anonymizer address (not on the `blocked_depositors` list) can fund notes without a screener signature.

The test `test_combined_regular_and_open_note_deposits_screened_independently` (test_server.cairo, line 2509) explicitly documents this as intended behavior: "Open-note deposit: depositor is the Invoke target (echo_executor), screened by the block list — not by an attestation."

### Assessment

This is a documented design choice, not an accidental omission. However, it creates an asymmetry: regular users require an off-chain screener attestation, but anyone operating an anonymizer contract (whose address is not blocked) can inject funds without attestation. The security relies entirely on the operator correctly maintaining the `blocked_depositors` denylist.

The risk is operational: if an anonymizer is deployed by a sanctioned entity before they are added to the block list, they have a window to deposit funds without any on-chain screening check.

---

## Finding 3 (CONFIRMED NOT A BUG): Double-Spend Prevention in `use_note`

**Location:** `use_note` (lines 536–584), `_apply_write_once` (lines 891–906)

### Analysis

The nullifier check works as follows:

**During compile phase** (`compile_and_panic` → `main` → `_client_apply_actions`):
- `use_note` generates a `WriteOnce` action targeting `self.nullifiers.entry(nullifier)`.
- `_client_apply_actions` calls `_apply_write_once` which reads the current storage value and asserts it is zero before writing.
- If the nullifier already exists (from a prior `apply_actions` call), `_apply_write_once` panics with `NON_ZERO_VALUE`.
- Because `compile_and_panic` is called via `call_contract_syscall` (which reverts inner-call storage writes on panic), the storage is unchanged, but the panic data propagates back.
- `extract_server_actions_from_compile_and_panic` would see a non-OK-wrapped panic and itself panic, aborting the client transaction.

**During apply phase** (`apply_actions`):
- The same `_apply_write_once` check runs again and catches any double-spend.

Double-spend is correctly prevented at both phases. **No bug.**

---

## Finding 4 (CONFIRMED NOT A BUG): Spending an Undeposited Open Note is Blocked

**Location:** `use_note` (lines 562–568), `decode_note_amount` (utils.cairo lines 287–297)

### Analysis

An open note before deposit has `packed_value = OPEN_NOTE_PACKED_VALUE = pack(salt=1, amount=0)`.

In `use_note`:
1. `packed_value.is_non_zero()` is `true` (the note exists) — passes.
2. `decode_note_amount` with `salt == OPEN_NOTE_SALT` returns the `amount` field directly: `0`.
3. `assert(amount.is_non_zero(), errors::ZERO_NOTE_AMOUNT_USAGE)` — **reverts**.

A user cannot spend an open note until it has been deposited. **No bug.**

---

## Finding 5 (CONFIRMED NOT A BUG): Multiple Same-Depositor `TransferFrom` Actions

**Location:** `_apply_actions` lines 812–821

### Analysis

The `MULTIPLE_DEPOSITORS` check (`deposit_depositor == input.from_addr`) allows multiple `TransferFrom` actions as long as they all share the same `from_addr`. Two `Deposit` client actions from the same user produce `TransferFrom { from_addr: user_addr, ... }` each — both pass because `from_addr` is identical. The test `test_multiple_deposits_same_depositor_pass` (test_server.cairo line 2449) confirms this. **No bug.**

---

## Finding 6 (CONFIRMED NOT A BUG): `_apply_transfer_from` with `from_addr == contract_address`

**Location:** `_apply_transfer_from` (lines 913–921)

### Analysis

If a user supplied `user_addr == privacy_contract_address`, `deposit` would produce a `TransferFrom { from_addr: privacy_contract, ... }`. This would call `transfer_from(privacy_contract, privacy_contract, amount)`, which requires the privacy contract to have approved itself. In practice this is impossible to trigger meaningfully: `user_addr` comes from the account executing `compile_and_panic`, which is the privacy contract itself only when `caller_address` is zero and `contract_address == user_addr`. The `extract_compile_actions_inputs` function sets `user_addr` from the calldata supplied in the `Call`, but `main` asserts `user_addr.is_non_zero()`. The privacy contract's own address would be non-zero. However, this edge case is harmless because: (a) the privacy contract would need to have self-approved the token spend, which is not a normal operation; and (b) if it somehow succeeded, it would be equivalent to the user spending the contract's own balance, not creating new funds. **No exploitable bug.**

---

## Finding 7 (CONFIRMED NOT A BUG): Race Condition on Open Note Deposits

**Location:** `_deposit_to_open_note` (lines 944–974)

### Analysis

Starknet executes transactions sequentially within blocks. Two `apply_actions` calls targeting the same undeposited open note cannot execute concurrently. The first succeeds and sets `current_amount` to non-zero; the second panics with `NOTE_ALREADY_DEPOSITED`. The revert undoes the second attempt. **No bug.**

---

## Summary Table

| # | Category | Verdict | Severity |
|---|----------|---------|----------|
| 1 | Cross-tx open note deposit → `TOO_MANY_OPEN_NOTES_DEPOSITED` | **REAL BUG** | High |
| 2 | Open note deposits bypass screener attestation | Design limitation | Low |
| 3 | Double-spend via nullifier WriteOnce | Not a bug | — |
| 4 | Spending undeposited open note | Not a bug | — |
| 5 | Multiple same-depositor `TransferFrom` | Not a bug | — |
| 6 | `from_addr == contract_address` | Not a bug | — |
| 7 | Open note race condition | Not a bug | — |
