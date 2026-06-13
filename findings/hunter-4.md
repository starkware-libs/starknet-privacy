# Hunter 4 Findings

## Investigated Areas

- `set_viewing_key` and the `EncPrivateKey` struct serialization
- `compile_and_panic` / `compile_actions` / `extract_server_actions_from_compile_and_panic`
- `__execute__` / `__validate__` flow and signature validation order
- `has_replay_protection` flag logic in `_client_apply_actions`

---

## Bug 1: `use_note` compile phase skips spent-nullifier check — double-spend attempt emits L1 message

**File:** `packages/privacy/src/privacy.cairo:529-577` (`use_note`), `packages/privacy/src/privacy.cairo:702-723` (`_client_apply_actions`)

**Description:**
`use_note` compiles to `[WriteOnce(nullifier), EmitNoteUsed]`. During the compile phase (inside `compile_and_panic` via inner syscall), `_client_apply_actions` applies the `WriteOnce(nullifier)` action to storage, reads the nullifier slot, asserts it is zero, and writes it. Since the inner call panics at the end, these writes are reverted.

However, the `use_note` function itself does NOT read the nullifier from storage to check whether the note has already been spent. It only reads `subchannel_exists` and `notes[note_id].packed_value`. The double-spend check only happens in `_apply_write_once` during `_client_apply_actions`. If the nullifier slot is ALREADY non-zero (i.e., the note was already spent in a prior transaction), `_apply_write_once` will panic with `NON_ZERO_VALUE`, and the compile phase will fail correctly.

This behavior is actually correct — no state escapes the inner call. **However**, there is a subtle issue with TOCTOU: a user can compile a `use_note` transaction at time T₁ (nullifier is zero at that moment), then at time T₂ (before `apply_actions` is called) another transaction spends the same note. The compile at T₁ succeeds, the L1 message is sent, but the server's `apply_actions` at T₃ rejects it with `NON_ZERO_VALUE`. This is by design and acceptable for the security model.

**Root Cause:**
The compile-phase nullifier check is implicit (deferred to `_apply_write_once`) rather than an explicit early assertion in `use_note`. The system relies on the server-side `_apply_write_once` to reject double-spends atomically.

**Severity:** Informational — security property holds; the spent-nullifier check correctly rejects double-spend at the server. The "wasted L1 message" is a gas/UX concern, not a security failure.

**Assessment:** NOT A BUG — this is consistent with the design pattern where the server is the final authority on state validity.

---

## Bug 2: `compile_and_panic` is publicly callable with `ref self` — temporary storage writes during compile

**File:** `packages/privacy/src/privacy.cairo:225-233`

**Description:**
`compile_and_panic` is declared `ref self: ContractState` (mutable) and is publicly accessible via the `IClient` interface. It calls `main()`, which calls `_client_apply_actions`, which calls `_apply_write_once` and `_apply_append`. These write to contract storage. The function always panics at the end via `panic_with_server_actions`.

When called via `call_contract_syscall` (as in `compile_actions`), the inner call is sandboxed: all storage writes are reverted when the call panics. This is correct.

When called directly via a transaction (external call), the storage writes happen in the outer call context. Since `compile_and_panic` always panics, the ENTIRE outer transaction reverts, undoing those writes. No state persists.

However, the function is documented as:
> "This function ensures that the contract state cannot be modified by client's functions."

This claim is technically true only because the function always panics. The mechanism relying on "always panics therefore always reverts" is fragile: if a future refactor inadvertently allows a non-panicking code path, storage writes would persist without the L1 message being sent. The structural guarantee should be that `compile_and_panic` uses a read-only self snapshot (`self: @ContractState`), but instead it mutates and relies on a runtime panic for safety.

**Root Cause:**
`compile_and_panic` uses `ref self` (mutable state) rather than `self: @ContractState` (snapshot). The safety guarantee comes from the runtime invariant "always panics" rather than the type system.

**Severity:** Low — not currently exploitable, but represents a fragile design where the safety invariant is enforced by runtime behavior rather than type-level immutability. A refactoring that introduces a non-panicking early return would silently break state isolation.

**Test Code:**
```cairo
#[test]
fn test_compile_and_panic_is_always_panicking() {
    // Verify that compile_and_panic always panics and never returns normally.
    // If it ever returned normally, state writes from _client_apply_actions would persist
    // without a corresponding L1 message, breaking the compile-apply atomicity guarantee.
    let mut test: Test = Default::default();
    let mut user = test.new_user();
    user.set_viewing_key_e2e();
    let random = user.get_random();

    // Calling compile_and_panic directly must always error.
    let result = user
        .privacy
        .safe_compile_and_panic(
            user_addr: user.address,
            user_private_key: user.private_key,
            client_actions: [
                ClientAction::SetViewingKey(SetViewingKeyInput { random })
            ]
                .span(),
        );
    // If this is Ok(()), it means compile_and_panic returned normally — a critical invariant
    // violation.
    assert!(result.is_err(), "compile_and_panic must always panic");

    // After the call, the user must NOT be registered — the state write must have been reverted.
    assert_eq!(
        user.get_public_key(), Zero::zero(), "state must be unchanged after compile_and_panic",
    );
}
```

**How to verify:**
```
~/.asdf/installs/starknet-foundry/0.59.0/bin/snforge test privacy::tests::test_client::test_compile_and_panic_is_always_panicking
```

---

## Bug 3: `__execute__` signature validation AFTER `compile_actions` — correct but counter-intuitive ordering

**File:** `packages/privacy/src/privacy.cairo:184-202`

**Description:**
In `__execute__`, the order is:
1. `compile_actions(...)` — calls `compile_and_panic` via syscall; inner call reverts all writes.
2. `assert_valid_signature(user_addr, tx_info)` — checks signature.
3. `send_message_to_server(...)` — sends L1 message.

If `assert_valid_signature` fails (step 2), the `__execute__` reverts. Since `compile_actions` (step 1) internally uses `call_contract_syscall` which sandboxes the inner call, ALL storage writes from the compile phase are already reverted by the time step 2 runs. The L1 message (step 3) is never sent. This is correct.

**However**, the signature validation after `compile_actions` means:
- An attacker can call `compile_actions` (which is `@self`, read-only view function) with any `user_private_key` without a signature.
- An attacker can call `compile_and_panic` with any inputs and observe the panic data (to explore what server actions would be produced).
- Neither allows state modification or L1 messages.

**Root Cause:**
Signature validation could logically come BEFORE `compile_actions` to reduce unnecessary compute. The current order is safe because the compile phase is sandboxed, but validates less eagerly.

**Severity:** Informational — no security impact. Signature check after compile is safe because compile phase is sandboxed. Re-ordering would be a gas optimization (reject invalid signatures before doing compile work) but not a security fix.

**Assessment:** NOT A BUG — the ordering is safe. Consider reordering for gas efficiency:

```cairo
// Suggested safer ordering (gas optimization):
fn __execute__(ref self: ContractState, calls: Array<Call>) {
    // ...
    let (user_addr, user_private_key, client_actions) = extract_compile_actions_inputs(...);
    assert_valid_signature(:user_addr, :tx_info);  // ← validate first
    let server_actions = self.compile_actions(...); // ← then compile
    send_message_to_server(...);
}
```

---

## Bug 4: `has_replay_protection` — `Deposit` and `Withdraw` correctly excluded, logic is sound

**File:** `packages/privacy/src/privacy.cairo:702-723` (`_client_apply_actions`), `packages/privacy/src/privacy.cairo:295` (`main`)

**Description:**
`has_replay_protection` is set to `true` only when a `ServerAction::WriteOnce` is applied. The following client actions do NOT produce WriteOnce:
- `Deposit` → `[TransferFrom, EmitDeposit]`
- `Withdraw` → `[TransferTo, EmitWithdrawal]`
- `InvokeExternal` → `[Invoke]`

Transactions containing only these actions will fail with `NO_REPLAY_PROTECTION`.

The following produce WriteOnce (replay protection):
- `SetViewingKey` → `[WriteOnce(public_key), WriteOnce(enc_private_key), EmitViewingKeySet]`
- `OpenChannel` → `[Append, WriteOnce(channel_exists), WriteOnce(outgoing_channels)]`
- `OpenSubchannel` → `[WriteOnce(subchannel_tokens), WriteOnce(subchannel_exists)]`
- `UseNote` → `[WriteOnce(nullifier), EmitNoteUsed]`
- `CreateEncNote` → `[WriteOnce(notes[id]), EmitEncNoteCreated]`
- `CreateOpenNote` → `[WriteOnce(notes[id]), EmitOpenNoteCreated]`

A valid transaction must include at least one of the WriteOnce-producing actions, plus the token-balance-neutral constraint (Deposit amount must be consumed by CreateEncNote/CreateOpenNote; UseNote credit must be consumed by Withdraw).

**Assessment:** NOT A BUG — the replay protection logic is correctly implemented and matches the documented invariant.

---

## Bug 5: `set_viewing_key` — auditor key rotation creates irreversible audit gap for existing users

**File:** `packages/privacy/src/privacy.cairo:305-343` (`set_viewing_key`), `packages/privacy/src/privacy.cairo:987-990` (`set_auditor_public_key`)

**Description:**
`set_viewing_key` reads `self.auditor_public_key.read()` at registration time and encrypts the user's private key to that key. The `EncPrivateKey` struct embeds the `auditor_public_key` that was used:

```cairo
EncPrivateKey { auditor_public_key, ephemeral_pubkey, enc_private_key }
```

If the security governor calls `set_auditor_public_key` to rotate the auditor key:
1. All future `set_viewing_key` calls will encrypt to the new key.
2. All pre-rotation users have `enc_private_key` encrypted to the OLD key.
3. The new auditor cannot decrypt historical `enc_private_key` values or any historical channel activity for pre-rotation users.

This is documented in the interface:
> "Rotating the auditor key creates a persistent audit gap: enc_private_key is encrypted to the auditor key active at registration..."

However, the `set_auditor_public_key` function does not emit a warning, does not require a time-lock, and has no mechanism to prevent accidental rotation that destroys the audit trail for all existing users.

**Root Cause:**
The `auditor_public_key` is a singleton storage slot that applies globally. There is no per-user key versioning.

**Severity:** Medium (operational risk) — not a code exploit, but a governance process risk. A mistaken or malicious key rotation by the security governor permanently severs the audit trail for all pre-rotation users, with no recovery mechanism in the contract itself.

**Assessment:** DESIGN CONCERN — the current contract acknowledges this risk in docs but provides no on-chain safeguards (e.g., time-locks, multi-sig requirements, per-user key binding). The `EncPrivateKey.auditor_public_key` field is stored but is not used for re-encryption or re-keying in any way.

---

## Summary Table

| # | Title | Severity | Real Bug? |
|---|-------|----------|-----------|
| 1 | `use_note` compile skips explicit nullifier check | Informational | No (by design) |
| 2 | `compile_and_panic` is `ref self` — fragile safety via runtime invariant | Low | Yes (design smell) |
| 3 | Signature validated after compile in `__execute__` | Informational | No (safe by sandboxing) |
| 4 | `has_replay_protection` excludes Deposit/Withdraw/InvokeExternal | Informational | No (correct by design) |
| 5 | Auditor key rotation permanently severs audit trail | Medium | Design concern |

## Confirmed Not Bugs (per investigation)

**Hypothesis: `_apply_write_once` zero-check on `EncPrivateKey.auditor_public_key`**
The serialized `EncPrivateKey` is `[auditor_public_key, ephemeral_pubkey, enc_private_key]`. The `_apply_write_once` check `value[0].is_non_zero()` checks `auditor_public_key`. Since `_set_auditor_public_key` enforces non-zero via `assert(auditor_public_key.is_non_zero(), errors::ZERO_AUDITOR_PUBLIC_KEY)`, and the constructor calls `_set_auditor_public_key`, the auditor key in storage at `set_viewing_key` time is always non-zero. The WriteOnce check will never hit `UNEXPECTED_ZERO_VALUE` for `EncPrivateKey`.

**Hypothesis: `extract_server_actions_from_compile_and_panic` injection**
The parser strictly validates: `[OK_WRAPPER, <ServerActions>, OK_WRAPPER, ENTRYPOINT_FAILED, <nothing>]`. The `ENTRYPOINT_FAILED` sentinel is appended by the Starknet OS (not by contract code), making it an unforgeable terminator. An attacker within `compile_and_panic` who panics with `[OK_WRAPPER, <payload>, OK_WRAPPER]` will have the OS append another `ENTRYPOINT_FAILED`, producing `[OK_WRAPPER, <payload>, OK_WRAPPER, ENTRYPOINT_FAILED]`. This matches valid format. However, this panic data would come from within `main()`, meaning it would only occur if `main()` itself panicked with `OK_WRAPPER` as the first element. Since all error assertions use short felt strings (not `OK_WRAPPER = 'PRIVACY_OK_WRAPPER'`), there is no reachable code path that causes `main()` to panic with `OK_WRAPPER` as the first panic element — unless a deliberate future modification introduced one. The architecture correctly uses `OK_WRAPPER` as an otherwise-unused sentinel.

**Hypothesis: `__execute__` — compile phase state persists if signature fails**
False. `compile_actions` calls `compile_and_panic` via `call_contract_syscall`. The inner call panics, reverting ALL its storage writes. The outer `compile_actions` call receives the panic data as `Err(...)` from the syscall — no state from the inner call persists. When `assert_valid_signature` subsequently fails, no storage writes exist to undo from the compile phase.
