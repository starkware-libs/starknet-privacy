# Supervisor 2 — Audit Verdicts

**Scope:** Hunter 6, Hunter 7 findings.
**Note:** Hunter 5 and Hunter 8 reports do not exist in the findings directory. Their assigned
topics (cross-tx open note deposit and signature malleability) overlap with findings made by
Hunter 7 and the snip12 analysis below. Each overlap is addressed in the relevant section.

---

## Summary Table

| Hunter | Finding | Verdict | Severity |
|--------|---------|---------|----------|
| 6 | F1: Enc note leaves `token` slot zero | INFORMATIONAL | Low |
| 6 | F2: `_prepare_note_creation` does not verify sender private key | CONFIRMED | Medium |
| 6 | F3: `create_open_note` silently discards `channel_key` | INFORMATIONAL | Info |
| 6 | F4: `create_open_note` has no salt — weaker privacy on retried tx | CONFIRMED | Low |
| 6 | F5: `index - 1` unsigned subtraction guarded only by short-circuit | INFORMATIONAL | Info |
| 6 | F6: Zero-amount enc note consumes index permanently | INFORMATIONAL | Info |
| 6 | F7: `open_subchannel` does not explicitly verify `recipient_public_key` | INFORMATIONAL | Info |
| 7 | F1: Self-invocation via `_apply_invoke` | CONFIRMED NON-ISSUE | None |
| 7 | F2: Re-entrancy guard covers `_apply_invoke` callback | CONFIRMED NON-ISSUE | None |
| 7 | F3: `_deposit_to_open_note` before `checked_sub` — depends on Cairo panic semantics | CONFIRMED NON-ISSUE | None |
| 7 | F4: `undeposited_open_notes` transaction-scoped; cross-tx deposits impossible | CONFIRMED | Informational |
| 7 | F5: Multiple `Invoke` entries unrestricted at server layer | INFORMATIONAL | Info |
| 7 | F6: `InvokeExternalInput` calldata unchecked in length | INFORMATIONAL | Info |
| Unassigned | Signature malleability in `is_screening_attestation_valid` | SUSPECTED | Low |

---

## Hunter 5 — Report Missing

The file `findings/hunter-5.md` does not exist. The assigned topic (cross-tx open note deposit /
`checked_sub` underflow DoS) was independently discovered by Hunter 7 (Finding 4). Hunter 7's
treatment of that topic is assessed below.

---

## Hunter 6 — Detailed Analysis

### Finding 1: Enc note leaves `token` slot zero

**Verdict: INFORMATIONAL**

**Code trace:** `create_enc_note` (line 618–622) calls `to_write_once_action(:storage_address,
value: packed_value)`, where `packed_value` is a `felt252`. The `Note` struct has two fields:
`packed_value` and `token`. The `WriteOnce` action is passed only the serialized `packed_value`
scalar, so it writes exactly one slot. The `token` field slot is never written and stays at the
storage default of zero.

This is deliberate — the comment on line 618 states "token is initialized to zero" — and is
consistent with the `Note` struct documentation in `objects.cairo` ("The token address of the note
(zero for encrypted notes)").

**Guard against misrouting:** `_deposit_to_open_note` (line 957) asserts `salt == OPEN_NOTE_SALT`
before reading `note_token`. An encrypted note has `salt >= 2`, so it is rejected before the
token field is ever compared. There is no path today where the zero token field causes
misbehavior.

**Hunter's claim:** The finding is accurately described and the latent risk is real: future code
that reads `Note.token` without first checking `salt` would silently see zero. The recommendation
to document this is reasonable. However, this is a documentation gap, not an exploitable bug
today.

**Test quality:** No PoC test was provided, but none is required for an informational/latent
finding of this type. The existing `_deposit_to_open_note` guard is correctly called out.

---

### Finding 2: `_prepare_note_creation` does not verify sender private key

**Verdict: CONFIRMED — Medium**

**Code trace:**

`open_channel` (lines 365–370) performs:
```cairo
let sender_public_key = self.public_key.read(sender_addr);
assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
assert(
    sender_public_key == derive_public_key(private_key: sender_private_key),
    errors::SENDER_NOT_AUTHENTICATED,
);
```

`_prepare_note_creation` (lines 671–707) does NOT perform this check. It computes
`channel_key = compute_channel_key(:sender_addr, :sender_private_key, ...)` and then checks
only that a subchannel exists for the resulting `subchannel_marker`. No comparison is made
between `derive_public_key(sender_private_key)` and `self.public_key.read(sender_addr)`.

**Attack scenario precision:**

For the attack to succeed, Alice must:
1. Have registered with key `k_A` via `set_viewing_key`.
2. Have separately opened a channel using a second key `k_B` — but this itself requires calling
   `open_channel` with `k_B`, which DOES perform the authentication check. `open_channel` would
   reject `k_B` because `derive_public_key(k_B) != self.public_key.read(Alice)`.

This is the critical flaw in Hunter 6's attack scenario: the attacker cannot open a channel with
`k_B` under `sender_addr = Alice` because `open_channel` authenticates the private key. So the
precondition "Alice has opened a subchannel with `k_B`" cannot be achieved via the normal
`open_channel` path if Alice is registered with `k_A`.

However, the finding still holds in a subtler form: a user who changes their registered key
(if key rotation is ever added), or who registers initially with `k_A` but then wants to create
notes using an old channel opened with `k_A` before they updated their key — the sequencing risk
is real. More concretely today: `main` receives `user_private_key` from the calldata, asserts
it is non-zero and canonical (`is_canonical_key`), but does NOT assert it matches the registered
key before dispatching to `create_enc_note` / `create_open_note`. A user can call
`compile_actions` with any canonical private key and, if a subchannel exists for the channel
derived from that key, successfully create a note. The subchannel is the only authorization
gate.

**Auditor visibility impact:** The auditor's key registry stores `enc_private_key` for the key
registered at `set_viewing_key`. Notes created via a different private key are bound to a
`channel_key` the auditor cannot reconstruct from the registered key. Hunter 6 correctly
identifies this as a break in auditor visibility.

**Practical exploitability:** The precondition "there exists a subchannel opened with an
unregistered key" requires that `open_channel` was somehow called with that key. Since
`open_channel` also checks key registration, both `open_channel` and `_prepare_note_creation`
would need to be bypassed. Today, with immutable viewing keys and the `open_channel`
authentication check, the only way to have a subchannel reachable via `k_B` is if `k_B` is the
registered key (defeating the attack) or if the subchannel was opened in a block where the
registration check was absent (e.g., a contract upgrade scenario).

**Severity assessment:** The severity is correctly assessed as Medium. The auditor-visibility
consequence is a real privacy invariant violation even if the immediate financial risk to users is
low. The missing check is an inconsistency in the code's own authentication model.

**Test:** No PoC test provided. A meaningful test would require either a specially crafted
subchannel or a mechanism to have `k_B` produce a valid subchannel. Given the `open_channel`
guard, the test scenario as described by Hunter 6 is not fully achievable through normal
entrypoints. The finding is still correct conceptually but the severity argument would benefit
from a working PoC.

---

### Finding 3: `create_open_note` silently discards `channel_key`

**Verdict: INFORMATIONAL**

**Code trace:** Line 640: `let (_, storage_address, note_id) = self._prepare_note_creation(...)`.
The `_` binding discards `channel_key`. Hunter 6 acknowledges no bug in behavior — this is a
code-smell finding. The observation is accurate: open notes encrypt the recipient address for the
auditor but do not use `channel_key` for that purpose. The discard is correct.

No security impact.

---

### Finding 4: `create_open_note` has no salt — weaker privacy on retried transactions

**Verdict: CONFIRMED — Low**

**Code trace:** `CreateOpenNoteInput` (actions.cairo lines 120–133) has `random` but no `salt`
field. `CreateEncNoteInput` (actions.cairo lines 84–117) has both `salt` and `random`. The
comment on `CreateEncNoteInput` explains that `salt` prevents data leakage if a transaction is
reverted and the same note id is reused.

For `create_open_note`, the on-chain stored `packed_value` is always `OPEN_NOTE_PACKED_VALUE =
pack(1, 0)` regardless of how many times the transaction is retried. An observer watching the
mempool or failed transaction trace will see identical on-chain data for every retry at the same
`(channel_key, token, index)`. For enc notes, the emitted `packed_value` differs per retry
because of the salt.

**Impact:** The privacy guarantee for open note creation is weaker than for enc notes under
reverted-retry scenarios. This is an asymmetry in the protocol's privacy model that is not
documented. Hunter 6's assessment is accurate.

**Practical impact:** An attacker watching failed L2 transactions can correlate retry attempts for
the same open note. This is a real (if niche) privacy degradation.

---

### Finding 5: `index - 1` unsigned subtraction guarded only by short-circuit

**Verdict: INFORMATIONAL**

**Code trace:** `_prepare_note_creation` lines 691–700:
```cairo
assert(
    index.is_zero()
        || self.notes.entry(compute_note_id(..., index: index - 1))...is_non_zero(),
    errors::INDEX_NOT_SEQUENTIAL,
);
```

Cairo `usize` subtraction panics on underflow. The `index.is_zero()` short-circuit is the only
protection. If this guard were removed or refactored, `index - 1` with `index == 0` would panic.
The pattern is correct but fragile. Hunter 6's observation is accurate.

No security impact today. The same pattern exists in `open_channel` (line 378) and
`open_subchannel` (line 444), so it is consistent across the codebase — not an isolated oversight.

---

### Finding 6: Zero-amount enc note consumes index permanently

**Verdict: INFORMATIONAL**

**Code trace:** `CreateEncNoteInput::assert_valid` (actions.cairo line 106) explicitly allows
`amount = 0` with the comment "Zero amount is allowed to enable note creation on reverted
transaction indexes." `_encrypt_note_amount` with `amount = 0` returns `enc_amount_hash.low`,
which is non-zero with overwhelming probability. Hunter 6's analysis of the decryption round-trip
is correct.

This is by design: placeholder zero-amount notes fill reverted indexes to prevent index-reuse
data leakage. Hunter 6 acknowledges this is intended behavior. No bug.

---

### Finding 7: `open_subchannel` does not explicitly verify `recipient_public_key`

**Verdict: INFORMATIONAL**

**Code trace:** `open_subchannel` (lines 436–440) checks:
```cairo
let channel_marker = compute_channel_marker(:channel_key, :sender_addr, :recipient_addr,
    :recipient_public_key);
assert(self.channel_exists.read(channel_marker), errors::INVALID_CHANNEL);
```

This validates the 4-tuple `(channel_key, sender_addr, recipient_addr, recipient_public_key)`
by checking the channel was opened with exactly those values. Since `open_channel` verified
`recipient_public_key` against on-chain storage at open time, the channel_marker check provides
indirect, binding validation.

Hunter 6 correctly notes this relies on key immutability. If key rotation were added, a stale
`recipient_public_key` could pass the channel_marker check while the on-chain key had changed.
With the current write-once `public_key` storage, there is no exploit path.

This is a reasonable latent-fragility observation, but it is not a bug today.

---

## Hunter 7 — Detailed Analysis

### Finding 1: Self-invocation of privacy contract via `_apply_invoke` — safe

**Verdict: CONFIRMED NON-ISSUE**

**Code trace:** `_apply_invoke` (line 929) calls `call_contract_syscall` with no guard on
`contract_address == get_contract_address()`. The privacy contract's ABI exposes `IClient`,
`IServer`, `IAdmin`, `IViews`, and OZ components — none expose `privacy_invoke` (selector
`selector!("privacy_invoke")`). The syscall would return `ENTRYPOINT_NOT_FOUND` and
`.unwrap_syscall()` would panic, reverting the transaction. Hunter 7's analysis is correct and
confirmed by the referenced test.

---

### Finding 2: Re-entrancy guard covers `_apply_invoke` callback

**Verdict: CONFIRMED NON-ISSUE**

**Code trace:** `apply_actions` (line 740) calls `self.reentrancy_guard.start()` before
`_apply_actions`, which in turn calls `_apply_invoke`. Any re-entrant attempt to `apply_actions`
from an invoked contract will hit the active guard and revert. The `mock_reentrancy.cairo` test
exercises this scenario. Hunter 7's analysis is correct.

---

### Finding 3: `_deposit_to_open_note` executes before `checked_sub` — state changes occur before potential panic

**Verdict: CONFIRMED NON-ISSUE (with documented fragility)**

**Code trace:** In `_apply_actions` (lines 835–844):
```cairo
for deposit in open_note_deposits {
    self._deposit_to_open_note(depositor: open_note_depositor, deposit: *deposit);
}
undeposited_open_notes = undeposited_open_notes
    .checked_sub(open_note_deposits.len())
    .expect(internal_errors::TOO_MANY_OPEN_NOTES_DEPOSITED);
```

ERC20 `transferFrom` calls and storage writes happen before `checked_sub`. If `checked_sub`
panics, Cairo's all-or-nothing panic semantics revert all state changes. Hunter 7 correctly
identifies that this is safe today but would become a real bug if Cairo ever introduced partial-
commit semantics. The fragility observation is accurate and worth documenting.

The test at line 1562 (`test_undeposited_open_notes`) confirms the panic reverts cleanly with
no state change.

---

### Finding 4: `undeposited_open_notes` counter is transaction-scoped; cross-tx deposits impossible

**Verdict: CONFIRMED — Informational**

**Code trace:** `undeposited_open_notes` is initialized to `0` at line 804 and incremented
only on `EmitOpenNoteCreated` in the same `_apply_actions` call (line 851). Deposits returned
by `Invoke` decrement this counter (line 842–844). If an `Invoke` returns a deposit for a note
that was created in a prior transaction, `undeposited_open_notes` is 0, `checked_sub` returns
`None`, and the transaction panics with `TOO_MANY_OPEN_NOTES_DEPOSITED`.

**Is this a bug or a design constraint?** The behavior is self-consistent with the design: the
`undeposited_open_notes` counter is a within-transaction balance sheet, not a reference to
persistent storage of undeposited notes. The contract's invariant — that every open note created
in a transaction must be deposited in the same transaction — is enforced by `assert(undeposited_open_notes == Zero::zero(), errors::UNDEPOSITED_OPEN_NOTES)` at line 857.

This is a design constraint that should be documented. The error message `TOO_MANY_OPEN_NOTES_DEPOSITED` is confusing when the root cause is "zero notes created in this tx, one deposit attempted." Hunter 7's recommendation to improve the error message or add documentation is sound.

**Cross-tx "DoS" assessment:** The panic scenario described is not a DoS from an external actor's
perspective. An anonymizer that returns a deposit for a pre-existing note is behaving outside the
protocol's intended usage. The revert prevents the deposit without any lasting harm. There is no
way for an external party to trap user funds using this mechanism.

**Test:** The test at `test_server.cairo:1562` specifically covers `TOO_MANY_OPEN_NOTES_DEPOSITED`
via invoking with a deposit when the note was created via `cheat_create_open_note` (i.e., not in
the same `apply_actions` call). This is a meaningful test that exercises the correct failure mode.

---

### Finding 5: Multiple `ServerAction::Invoke` entries unrestricted at server layer

**Verdict: INFORMATIONAL**

**Code trace:** `assert_and_advance_phase` (actions.cairo lines 277–286) advances `curr_phase` to
`INVOKE_PHASE + 1` after a single `InvokeExternal`, preventing a second `InvokeExternal` at the
client layer. However, `_apply_actions` processes `ServerAction::Invoke` with no count limit.

As Hunter 7 correctly notes, `validate_proof` ties the action list to a valid STARK proof and
L1 message, so the server cannot be fed an arbitrary action list. The attack surface is limited
to the STARK circuit itself. This is a defense-in-depth gap, not a directly exploitable
vulnerability.

---

### Finding 6: `InvokeExternalInput` calldata length unchecked

**Verdict: INFORMATIONAL**

**Code trace:** `InvokeExternalInputValid::assert_valid` (actions.cairo line 215) checks only
`contract_address.is_non_zero()`, ignoring `calldata`. Hunter 7's analysis is accurate: the
missing length cap is a documentation/specification gap with no direct on-chain exploit today,
since StarkNet gas pricing makes unbounded calldata economically self-limiting.

---

## Hunter 8 — Report Missing; Signature Malleability Analysis (Unassigned)

The file `findings/hunter-8.md` does not exist. The assigned topic was signature malleability in
`is_screening_attestation_valid`. I traced this independently.

### Signature Malleability in `is_screening_attestation_valid`

**Verdict: SUSPECTED — Low**

**Code trace:** `snip12.cairo` line 48:
```cairo
check_ecdsa_signature(message_hash, signer_public_key, r, s)
```

There is no check that `s < HALF_ORDER`. The contract defines `HALF_ORDER` in `utils.cairo` and
uses it only for `is_canonical_key` (applied to the user's `user_private_key` in `main`). The
private-key canonicalization check prevents canonical-key-related signature malleability for user
actions, but the screener attestation verification uses a separate code path with no `s < N/2`
check.

**Cairo's `check_ecdsa_signature` behavior:** Cairo's built-in ECDSA verification (from
`core::ecdsa`) is backed by the STARK curve ECDSA builtin. The ECDSA mathematical definition
accepts both `(r, s)` and `(r, N-s)` as valid signatures for the same `(r, message_hash, public_key)`. Whether the Cairo builtin enforces low-s canonicalization is not definitively
determinable from the source files available in this repository (the corelib is not present).

**Practical impact:** If `check_ecdsa_signature` accepts both `s` and `N-s`:
- The screener issues a canonical attestation `(r, s)` where `s < N/2`.
- An attacker observing this on-chain derives `(r, N-s)` without knowing the screener's private
  key.
- The attacker submits an `apply_actions` call with a deposit using the malleable signature
  `(r, N-s)` as the screening attestation.
- The attestation's `issued_at` timestamp is still valid (within the 300-second window), so
  the `SCREENING_EXPIRED` check does not catch this.
- The contract would accept the malleable signature as valid, allowing the attacker to re-use an
  observed attestation to deposit without the screener's fresh approval.

**Severity:** If `check_ecdsa_signature` does accept `(r, N-s)`, this is a Low severity issue: an
attacker could re-use a screener attestation within the 5-minute validity window using a
malleable signature. The attacker cannot extend the validity window or use a different depositor
address — only replay the same `(depositor, issued_at)` with the flipped `s`. Within the
5-minute window the original signature would also work, so the marginal uplift is limited to
scenarios where the screener refuses to re-sign but the window has not expired.

**Test coverage:** `test_snip12.cairo` tests valid signatures, wrong signer, tampered depositor,
tampered `issued_at`, and tampered `r`. There is no test for `(r, N-s)`. This gap means the
malleability property is untested.

**Confidence:** SUSPECTED rather than CONFIRMED because the Cairo builtin behavior is not
verifiable from the repository alone. Historical behavior of StarkWare's ECDSA builtin has varied:
pre-0.10 accepted both forms; post-0.10 may enforce low-s. The contract's own use of
`is_canonical_key` for user private keys — which enforces `key < HALF_ORDER` — and the absence
of any analogous check for attestation signatures suggests the authors may not have considered
malleability here.

**Recommendation:** Add `assert(s.into() < HALF_ORDER, errors::SCREENING_INVALID_SIGNATURE)`
before calling `check_ecdsa_signature`, consistent with how the contract handles private key
canonicalization. Add a test with `(r, N-s)` to confirm the expected rejection.

---

## Summary of Key Findings

**Confirmed, action-worthy:**

1. **Hunter 6 F2 (Medium):** `_prepare_note_creation` does not verify `sender_private_key`
   against the registered public key. Breaks auditor visibility when a user creates notes with
   a non-registered key that has a valid subchannel. The practical precondition is constrained by
   `open_channel`'s own authentication check, but the inconsistency in the contract's
   authentication model is real.

2. **Hunter 6 F4 (Low):** `create_open_note` lacks a salt, giving weaker privacy guarantees for
   retried transactions compared to `create_enc_note`.

3. **Unassigned (Low, Suspected):** Signature malleability in `is_screening_attestation_valid`
   — no `s < HALF_ORDER` check, inconsistent with `is_canonical_key` usage elsewhere. Practical
   exploit window limited to the 300-second attestation validity period.

**Non-issues (correctly identified):**

- Hunter 7 F1, F2, F3: Self-invocation, re-entrancy guard, and panic-ordering are all safe.

**Informational / design constraints:**

- All remaining findings are accurately described but carry no direct exploit path today.
- The cross-tx deposit constraint (Hunter 7 F4) and the confusing error message merit
  documentation fixes.

**Missing reports:**

- Hunter 5: Not found. Topic covered by Hunter 7 F4.
- Hunter 8: Not found. Topic assessed independently above.
