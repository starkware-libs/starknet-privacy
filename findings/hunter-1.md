# Bug Hunter 1 — Findings Report

## Scope

Files analyzed:
- `/home/user/starknet-privacy/packages/privacy/src/actions.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/privacy.cairo` (full)
- `/home/user/starknet-privacy/packages/privacy/src/errors.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/objects.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/utils.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/tests/utils_for_tests.cairo`

---

## Bug 1: Token balance overflow on multi-note spending

**File**: `packages/privacy/src/objects.cairo:13`

**Description**: `add_balance` performs an unchecked `u128` addition. If a user uses multiple notes whose `amount` values sum to more than `u128::MAX`, the addition overflows and the transaction panics with a generic overflow error rather than a meaningful balance error. This prevents legitimate multi-note spending even when the amounts are economically valid on-chain.

**Root cause**: `TokenBalancesImpl::add_balance` does `current_balance + amount` with plain `u128` arithmetic. Cairo's `u128` addition panics on overflow (it does not wrap). The `UseNote` action calls `token_balances.add_balance(:token, :amount)` for the decoded amount of each note (line 573 of `privacy.cairo`). There is no cap or saturating arithmetic protecting against overflow. The amounts come from encrypted notes whose stored encrypted amount is a `u128`; theoretically two notes of `u128::MAX / 2 + 1` tokens each would trigger the panic.

**Impact**: Denial of service for users holding multiple large-denomination notes for the same token. The failure happens during `compile_actions` (inside the `compile_and_panic` sub-call), so the tx fails at compile time with an opaque overflow panic rather than `NEGATIVE_INTERMEDIATE_BALANCE`.

**Note**: In practice most ERC20 tokens have total supply well below `u128::MAX`, so this is a low-severity pathological case. However it is a correctness gap: the contract's stated error for insufficient balance is `NEGATIVE_INTERMEDIATE_BALANCE`, not a panic.

**Test**:
```cairo
// Conceptual: requires two notes each with amount close to u128::MAX.
// In practice this requires either minting an unrealistic token or crafting
// packed_value directly. A unit test calling add_balance twice:
#[test]
fn test_token_balance_overflow() {
    let mut balances: TokenBalances = Default::default();
    let token: ContractAddress = 'TOKEN'.try_into().unwrap();
    // First add succeeds.
    balances.add_balance(:token, amount: core::integer::BoundedInt::max());
    // Second add should overflow u128 arithmetic and panic.
    balances.add_balance(:token, amount: 1_u128);
}
```

**Verify**: `snforge test --exact packages/privacy::tests::token_balance_overflow`

---

## Bug 2: `InvokeExternal`-only transaction silently rejected with wrong error

**File**: `packages/privacy/src/privacy.cairo:302`, `packages/privacy/src/actions.cairo:277-286`

**Description**: A transaction containing ONLY a `ClientAction::InvokeExternal` (or `InvokeExternal` combined with only `Deposit` and/or `Withdraw`) fails with `NO_REPLAY_PROTECTION` rather than executing. `InvokeExternal` produces `ServerAction::Invoke`, which is not a `WriteOnce` action; `_client_apply_actions` therefore never sets `has_replay_protection = true`. The assertion at line 302 (`assert(has_replay_protection, errors::NO_REPLAY_PROTECTION)`) then trips.

**Root cause**: `_client_apply_actions` only sets `has_replay_protection = true` for `ServerAction::WriteOnce`. `InvokeExternal` produces `ServerAction::Invoke` (line 533), which has no `WriteOnce`. The comment for `has_replay_protection` says "at least one client action provides replay protection (WriteOnce)" — but `InvokeExternal` is the action specifically designed for external contract interaction, and users may legitimately want to deposit to a previously created open note without including any note/channel setup action.

**Impact**: Any user who wants to make an anonymous on-chain call (e.g., deposit to a pre-existing open note, trigger an AMM swap using a previously funded note) MUST include at least one note/channel action in the same tx. A pure `InvokeExternal` tx is impossible. This is likely intentional design (requiring replay protection for every tx), but it is an undocumented and surprising constraint that deserves explicit documentation or an error that better explains why.

**Logical argument**:
```
Tx: [ClientAction::InvokeExternal(input)]
  → phase 7 >= curr_phase 0: OK, curr_phase = 8
  → invoke_external() returns [ServerAction::Invoke(..)]
  → _client_apply_actions sees ServerAction::Invoke: no WriteOnce branch → has_replay_protection stays false
After loop: assert(false, NO_REPLAY_PROTECTION) → REVERT
```

**Verdict**: This is by design but should be documented explicitly. The error code `NO_REPLAY_PROTECTION` does not tell the user that they must add a note/channel action.

---

## Bug 3: Phase ordering allows `assert_and_advance_phase` to not advance `curr_phase` for non-INVOKE actions — multiple `SetViewingKey` passes phase check but fails on server side

**File**: `packages/privacy/src/actions.cairo:277-286`

**Description**: For all non-`InvokeExternal` actions, `assert_and_advance_phase` sets `curr_phase = action_phase` (does NOT increment). This means the same phase can be entered again by the same or any same-phase action. While this is intentional for multi-note and multi-deposit scenarios, it has a subtle consequence: **`SetViewingKey` can appear multiple times in one tx and passes the phase check both times**. The second `SetViewingKey` only fails in `_client_apply_actions` when the `WriteOnce` for `public_key` finds the storage slot already non-zero (set by the first one). The failure message is `NON_ZERO_VALUE` (an internal error) rather than a user-visible semantic error.

**Root cause**: The phase monotonicity rule `action_phase >= curr_phase` combined with `curr_phase = action_phase` (not `action_phase + 1`) allows any same-phase action to be repeated. For `SetViewingKey` this is especially confusing because re-registration is explicitly called out as "immutable once set."

**Example sequence**:
```
[SetViewingKey(random1), SetViewingKey(random2)]
phase check for both: 0 >= 0 → passes
_client_apply_actions for SetViewingKey(random1):
  WriteOnce(public_key) → success, has_replay_protection = true
  WriteOnce(enc_private_key) → success
_client_apply_actions for SetViewingKey(random2):
  WriteOnce(public_key) → FAILS: NON_ZERO_VALUE (storage already set)
```

The user sees `NON_ZERO_VALUE` (an `internal_errors` constant) when attempting to register twice in one tx.

**Verdict**: Not a critical bug — the WriteOnce enforcement catches it at compile time. But the error surface is poor. If `assert_and_advance_phase` incremented `curr_phase` by 1 for actions that are only allowed once (like `SetViewingKey`), the failure would be caught earlier with a clearer `ACTIONS_OUT_OF_ORDER` message. Low severity.

---

## Negative findings (areas investigated and found safe)

### Phase ordering correctness

All eight phases enforce non-decreasing order correctly. The specific ordering constraints:
- UseNote (4) < CreateEncNote/CreateOpenNote (5): prevents using notes created in the same tx — safe.
- CreateNote (5) < Withdraw (6): prevents withdrawing before notes are created — safe.
- All phases < InvokeExternal (7): InvokeExternal is always last — safe.

The `INVOKE_PHASE + 1 = 8` sentinel correctly prevents a second `InvokeExternal` since `INVOKE_PHASE (7) >= 8` is false.

### Same-transaction channel/subchannel/note creation

The compile phase (`compile_and_panic` sub-call) applies `WriteOnce` and `Append` actions immediately via `_client_apply_actions`. This means within one tx:
- `OpenChannel` → `channel_exists` written to storage → `OpenSubchannel` can read it. ✓
- `SetViewingKey` → `public_key` written → `OpenChannel` can read the sender's public key. ✓
- `CreateEncNote(idx=0)` → `notes[note_id_0].packed_value` written → `CreateEncNote(idx=1)` sequential check passes. ✓

These are all correct by design; state written by earlier actions in the loop is immediately visible to later actions in the same compile call.

### Note double-spend prevention

UseNote produces `WriteOnce(nullifiers[nullifier] = true)`. In `_client_apply_actions`, the first use writes the nullifier. If the same note is referenced twice in one tx, the second WriteOnce finds storage non-zero → `NON_ZERO_VALUE` panic. Across transactions, the nullifier persists from `apply_actions`. In all cases, double-spend is prevented. ✓

### Cross-user note theft

`use_note` verifies the subchannel marker as `compute_subchannel_marker(channel_key, owner_addr, owner_public_key, token)`. The `channel_key` is user-provided but the `subchannel_exists` check ensures a subchannel with exactly `(channel_key, owner_addr, owner_pk, token)` was opened by a sender. A malicious user providing a fake `channel_key` would fail `SUBCHANNEL_NOT_FOUND`. A user providing another user's `channel_key` would produce a different `subchannel_marker` (different `owner_addr`/`owner_pk`) that doesn't exist. ✓

### Token balance accounting integrity

Token balance tracking is correct:
- `Deposit` adds to balance; `Withdraw` subtracts.
- `UseNote` adds to balance (consumes note value); `CreateEncNote` subtracts (allocates to new note).
- `assert_valid` at end checks all tokens reach zero (net flow is balanced within tx).
- `subtract_balance` uses `checked_sub` which panics with `NEGATIVE_INTERMEDIATE_BALANCE` if intermediate balance would go negative. ✓

### `unpack`/`pack` and encrypted amount correctness

`pack(value_1, value_2)` creates `value_1 * 2^128 + value_2`. For `salt >= 2`, packed_value > 0 always. The wrapping arithmetic in `_encrypt_note_amount` and `decrypt_note_amount` correctly handles modular wrap-around for all u128 inputs. The `ZERO_NOTE_VALUE` assertion on `packed_value` is redundant (always true for valid salt) but harmless. ✓

### `_apply_write_once` first-element zero check

`_apply_write_once` checks `value[0].is_non_zero()`. For `EncPrivateKey`, the first element is `auditor_public_key`, validated non-zero by `_set_auditor_public_key`. For notes, `packed_value` (the first field) is guaranteed non-zero by the `ZERO_NOTE_VALUE` assertion. For `channel_exists` and `subchannel_exists` booleans serialized as `true`, the felt252 value is 1 (non-zero). No legitimate WriteOnce action produces a zero first element. ✓

### Open note lifecycle

Undeposited open notes have `amount = 0`. `decode_note_amount` returns 0 for them. `use_note` asserts `amount.is_non_zero()` → prevents using undeposited open notes. `_apply_actions` tracks `undeposited_open_notes` and asserts it reaches zero at the end, preventing open notes from being created without corresponding deposits. ✓

### `_verify_screening` and deposit enforcement

`_verify_screening` correctly enforces: no attestation is valid iff no `TransferFrom` was in the tx (depositor == zero). A tx with `TransferFrom` but no attestation fails with `SCREENING_REQUIRED`. A tx with an attestation but no `TransferFrom` fails with `UNEXPECTED_SCREENING`. ✓

### Multiple depositors prevention

`_apply_actions` tracks `deposit_depositor` (the `from_addr` of the first `TransferFrom`). Any subsequent `TransferFrom` with a different `from_addr` fails with `MULTIPLE_DEPOSITORS`. ✓

### Sequential index enforcement for channels and notes

All sequential index checks read from storage that is updated by earlier `_client_apply_actions` calls in the same tx. Opening channel idx=1 in same tx as idx=0 works. Creating note idx=1 after note idx=0 in same tx works. The `index - 1` subtraction is guarded by `index.is_zero() ||` short-circuit (Cairo `||` is short-circuiting), preventing underflow when `index = 0`. ✓

### Phase ordering for INVOKE_PHASE advancing past 7

After `InvokeExternal`, `curr_phase = 8`. Since `u8::MAX = 255`, no overflow. Any subsequent action (even another `InvokeExternal` at phase 7) fails `7 >= 8` → `ACTIONS_OUT_OF_ORDER`. Exactly one `InvokeExternal` per tx is enforced. ✓

---

## Summary

| # | Severity | Title |
|---|----------|-------|
| 1 | Low | Token balance overflow on multi-note u128 addition |
| 2 | Info | `InvokeExternal`-only tx rejected with `NO_REPLAY_PROTECTION` (likely intentional) |
| 3 | Info | Duplicate `SetViewingKey` passes phase check, fails on `NON_ZERO_VALUE` internal error |

No critical or high-severity logic bugs were found in the phase-ordering enforcement, note balance accounting, double-spend prevention, or cross-user isolation.
