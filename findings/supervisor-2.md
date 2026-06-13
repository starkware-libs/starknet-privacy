# Supervisor 2 Verdict Report — Hunters 5–8

**Scope:** Independent validation of bug claims from Hunters 5, 6, 7, and 8.
**Source files reviewed:** `objects.cairo`, `actions.cairo`, `privacy.cairo`, `errors.cairo`.

---

## H5 — Phase Ordering & Replay Protection (Hunter 5)

### H5-F1: `UseNoteInput::assert_valid` Does Not Reject Zero `channel_key`

**Verdict: CONFIRMED**
**Severity: LOW**

Code at `actions.cairo:175–179` explicitly pattern-destructs `channel_key: _` and performs no
non-zero check — only `token.is_non_zero()` is asserted. Zero `channel_key` passes validation and
fails later at `SUBCHANNEL_NOT_FOUND` (because `hash(SUBCHANNEL_MARKER_TAG, 0, ...)` maps to an
unset storage slot). The hash functions that consume `channel_key` document "assumes all inputs
are non-zero", so the validation gap is real. However, Hunter 5 correctly assesses this as a
defensive coding gap, not an exploitable vulnerability — the zero path fails safely. The error
message is misleading, and the hash invariant is silently violated at the API boundary.

### H5-F2: `OpenSubchannelInput::assert_valid` Does Not Reject Zero `channel_key`

**Verdict: CONFIRMED**
**Severity: LOW**

Code at `actions.cairo:68–78` pattern-destructs `channel_key: _` and performs no non-zero check.
Zero `channel_key` passes validation and fails at `INVALID_CHANNEL` (because
`hash(CHANNEL_MARKER_TAG, 0, ...)` maps to an unset `channel_exists` slot). Same category as
H5-F1 — misleading error, violated hash invariant, no exploitable consequence.

---

## H6 — Input Validation Audit (Hunter 6)

### H6-F1: Zero-Amount Encrypted Note — Cannot Be Spent

**Verdict: CONFIRMED (non-issue, correctly handled)**
**Severity: INFO**

Hunter 6's analysis is correct. `_encrypt_note_amount` produces a non-zero `packed_value` when
`salt >= 2` (the high bits are non-zero regardless of `enc_amount`). The note is stored
successfully. On `use_note`, `ZERO_NOTE_AMOUNT_USAGE` fires before any balance change. This is
intentional by design for reverted-index recovery and is documented in
`CreateEncNoteInputValid::assert_valid` (`actions.cairo:108–109`). Not a bug.

### H6-F2: `recipient_public_key` Not Validated as Valid Curve Point in `open_subchannel`

**Verdict: REJECTED (not exploitable)**
**Severity: INFO**

Hunter 6 ultimately reaches this conclusion themselves. The `open_channel` function pins
`recipient_public_key` to the on-chain public key registry (`self.public_key.read(recipient_addr)`).
`open_subchannel` then requires `channel_exists` to be true, where the channel marker is
`h(CHANNEL_MARKER_TAG, channel_key, sender_addr, recipient_addr, recipient_public_key)`. Since the
real channel was opened with the registry-bound public key, any crafted subchannel with a different
`recipient_public_key` will fail `INVALID_CHANNEL`. The missing curve-point check in
`OpenSubchannelInputValid::assert_valid` is a defense-in-depth gap but not an attack surface given
the existing chain of checks.

### H6-F3: Self-Subchannel Allowed

**Verdict: REJECTED (intentional design)**
**Severity: INFO**

Hunter 6 correctly identifies and self-rejects this. Test coverage at `test_client.cairo:196`
confirms self-channels are an intended feature (e.g., for change outputs in transfers).

### H6-F4: `WithdrawInput.to_addr` Can Be the Contract's Own Address

**Verdict: CONFIRMED**
**Severity: LOW**

`WithdrawInputValid::assert_valid` (`actions.cairo:195–203`) only checks `to_addr.is_non_zero()`.
Setting `to_addr = get_contract_address()` passes validation. The `withdraw` function at
`privacy.cairo:491–517` produces `ServerAction::TransferTo(TransferToInput { to_addr, token, amount })`.
`_apply_transfer_to` calls `checked_transfer(token_address: token, recipient: to_addr, amount: ...)`,
which is an ERC-20 self-transfer (contract sends tokens to itself). The ERC-20 balance is
unchanged, but `token_balances.subtract_balance` has already consumed the user's virtual balance
and the `EmitWithdrawal` event fires. The tokens become permanently unclaimable through the
privacy protocol. This is a genuine loss-of-funds path, even though only the caller is harmed.
The fix is a single guard: `assert(to_addr != get_contract_address(), errors::WITHDRAW_TO_SELF)`.

### H6-F5: `recipient_public_key` Not Cross-Checked with Registry in `_prepare_note_creation`

**Verdict: REJECTED (not a bug)**
**Severity: INFO**

Hunter 6 self-rejects this, and the reasoning is sound. Correctness is enforced transitively
through the subchannel existence check, which can only be satisfied if the subchannel was opened
via `open_subchannel`, which required a valid channel opened with the registry-pinned key.

### H6-F6: Zero-Deposit to Open Note Correctly Rejected

**Verdict: CONFIRMED (non-issue)**
**Severity: INFO**

Hunter 6's analysis is correct. The `ZERO_AMOUNT` guard and `UNDEPOSITED_OPEN_NOTES` check handle
this correctly. Not a bug.

### H6-F7: Zero `amount` Skipped in `CreateEncNoteInput::assert_valid`

**Verdict: CONFIRMED (intentional by design)**
**Severity: INFO**

`actions.cairo:106` pattern-destructs `amount: _`. The comment at lines 108–109 documents the
intent: zero amount is allowed for reverted-index recovery. Not a bug.

---

## H7 — TokenBalances & Balance Tracking (Hunter 7)

### H7-BUG-01: `add_balance` Uses Wrapping u128 Addition

**Verdict: CONFIRMED**
**Severity: MEDIUM** (downgraded from HIGH — see rationale)

`objects.cairo:13` uses `current_balance + amount` with no overflow guard. `subtract_balance` at
line 15–19 uses `checked_sub`, creating an asymmetry. In Cairo, `u128 +` panics on overflow in
debug mode and wraps in release/production mode (Sierra does not have checked arithmetic for
plain `+` on bounded integer types — overflow results in wrapping at the modular boundary).
This is a real semantic gap: `add_balance` should use `checked_add` to match the defensive posture
of `subtract_balance`.

**Why downgraded from HIGH to MEDIUM:**

Hunter 7 acknowledges the precondition requires notes summing to ≥ u128::MAX ≈ 3.4×10^38 in raw
token units. For any ERC-20 with even 1 decimal place, this is orders of magnitude beyond any
realistic total supply. Furthermore, as Hunter 7 notes in BUG-7-02, the "complete wraparound"
case (balance → 0) causes the subsequent `subtract_balance` to panic, self-defeating the attack.
Only partial wraparound to a positive value that exactly equals what the attacker wants to withdraw
is exploitable, which requires precise control over the sum. In practice no token economy enables
this for a single user. The bug is real and should be fixed for defensive correctness and
token-agnosticism, but HIGH severity overstates the actual exploit risk.

### H7-BUG-02: Complete Wraparound Self-Defeats Attack

**Verdict: CONFIRMED (supplementary analysis, not a separate bug)**
**Severity: INFO**

Hunter 7 is correct. When `current_balance + amount` wraps to exactly 0, any `subtract_balance`
call panics with `NEGATIVE_INTERMEDIATE_BALANCE`. This narrows the exploitable scenario to partial
wraparound only.

### H7-FINDING-03 through FINDING-07: Safe Analysis

**Verdict: All CONFIRMED SAFE**
**Severity: INFO**

Hunter 7's verification of nullifier double-spend protection (WriteOnce), SquashedFelt252Dict
zero-entry semantics, ContractAddress-to-felt252 collision impossibility, `enc_note_packed_value`
non-zero invariant, and zero-amount note usage rejection are all correct and corroborated by the
source code.

---

## H8 — WriteOnce Mechanism & Storage Layout (Hunter 8)

### H8-F1: `Note` Serde/Store Alignment — Correct

**Verdict: CONFIRMED (non-issue)**
**Severity: INFO**

Hunter 8 is correct. No bug.

### H8-F2: `EncPrivateKey` Serde/Store Alignment — Correct

**Verdict: CONFIRMED (non-issue)**
**Severity: INFO**

Hunter 8 is correct. No bug.

### H8-F3: `storage_path_to_felt252` Base Address — Correct

**Verdict: CONFIRMED (non-issue)**
**Severity: INFO**

Hunter 8 is correct. No bug.

### H8-F4: Offset `u8` Overflow in `_apply_write_once` for Long Value Spans

**Verdict: SUSPECTED**
**Severity: LOW** (downgraded from MEDIUM)

The code at `privacy.cairo:837–846` initializes `offset = 0` and increments it by 1 each iteration.
The `storage_address_from_base_and_offset` function takes `offset: u8` (this is a Starknet
built-in with a known `u8` offset parameter). Cairo's integer type inference will assign `offset`
the type required by the function call — i.e., `u8`. Incrementing a `u8` past 255 would panic in
debug mode or wrap in release mode. The theoretical overflow path therefore exists.

**However, the attack scenario is not executable in the current threat model.** The `apply_actions`
entry point requires `validate_proof` to pass before `_apply_actions` is called
(`privacy.cairo:728–735`). `validate_proof` checks that `message_to_l1_hashes == [compute_message_hash(actions)].span()`,
meaning the `actions` payload — including every `WriteOnceInput.value` — is committed to in a
ZK proof verified against L1. A malicious party cannot craft a `WriteOnceInput` with `value.len() > 255`
without generating a valid SNOS proof for it, which is computationally infeasible without access
to the proving infrastructure. All structs used in the normal flow (Note: 2 fields, EncPrivateKey:
3 fields, etc.) are far below 255.

Hunter 8's claim that "a malicious or misconfigured server could craft a WriteOnceInput with more
than 255 felts" assumes the server can call `apply_actions` directly without a valid proof, which
the code prevents. The finding is SUSPECTED rather than CONFIRMED because the overflow code path
exists and would be dangerous if the proof gate were bypassed (e.g., in a test environment or if
proof validation had a bug), but it is not reachable in production under the current architecture.
Adding a bound check (e.g., `assert(value.len() <= 8)`) is still worthwhile as defense-in-depth.

### H8-F5: `MULTIPLE_DEPOSITORS` Error Constant Is Dead Code

**Verdict: CONFIRMED**
**Severity: LOW**

`errors.cairo:54` defines `pub const MULTIPLE_DEPOSITORS: felt252 = 'MULTIPLE_DEPOSITORS'` but
`grep` of the entire `packages/privacy/src/` tree finds no reference to this constant outside of
`errors.cairo`. The `_apply_actions` loop allows multiple depositor addresses without complaint.
The dead constant suggests a removed enforcement. No security impact, but it is a code hygiene
issue that misleads future auditors.

### H8-F6: `UNEXPECTED_ZERO_VALUE` Only Checks `value[0]`

**Verdict: CONFIRMED**
**Severity: LOW**

`privacy.cairo:835` asserts `value[0].is_non_zero()` but does not check subsequent slots. For
an open note `Note { packed_value, token }`, `value[1] = token` is not checked by `_apply_write_once`
itself; correctness relies on `CreateOpenNoteInputValid::assert_valid` having rejected zero token
upstream. The gap is real: `_apply_write_once` is a general-purpose mechanism whose safety beyond
index 0 depends entirely on caller discipline. In the current flow, all callers enforce non-zero
for relevant slots. The `apply_actions` proof gate prevents direct exploitation. The finding is
a legitimate defense-in-depth gap.

---

## Summary Table

| Finding | Hunter | Verdict | Severity |
|---------|--------|---------|----------|
| H5-F1: `UseNoteInput` missing `channel_key` non-zero check | H5 | CONFIRMED | LOW |
| H5-F2: `OpenSubchannelInput` missing `channel_key` non-zero check | H5 | CONFIRMED | LOW |
| H6-F1: Zero-amount enc note cannot be spent | H6 | CONFIRMED (non-issue) | INFO |
| H6-F2: `recipient_public_key` not curve-validated in `open_subchannel` | H6 | REJECTED | INFO |
| H6-F3: Self-subchannel allowed | H6 | REJECTED | INFO |
| H6-F4: Withdrawal to contract's own address permanently locks funds | H6 | CONFIRMED | LOW |
| H6-F5: `recipient_public_key` not cross-checked with registry in note creation | H6 | REJECTED | INFO |
| H6-F6: Zero-deposit to open note correctly rejected | H6 | CONFIRMED (non-issue) | INFO |
| H6-F7: Zero `amount` skipped in `CreateEncNoteInput::assert_valid` | H6 | CONFIRMED (intentional) | INFO |
| H7-BUG-01: `add_balance` wrapping u128 addition | H7 | CONFIRMED | MEDIUM |
| H7-BUG-02: Complete wraparound self-defeats attack | H7 | CONFIRMED (supplementary) | INFO |
| H7-FINDING-03: Nullifier prevents double-spend | H7 | CONFIRMED SAFE | INFO |
| H7-FINDING-04: SquashedFelt252Dict semantics correct | H7 | CONFIRMED SAFE | INFO |
| H7-FINDING-05: No token address collision | H7 | CONFIRMED SAFE | INFO |
| H7-FINDING-06: `enc_note_packed_value` always non-zero | H7 | CONFIRMED SAFE | INFO |
| H7-FINDING-07: Zero-amount note usage guarded | H7 | CONFIRMED SAFE | INFO |
| H8-F1: `Note` Serde/Store alignment correct | H8 | CONFIRMED SAFE | INFO |
| H8-F2: `EncPrivateKey` Serde/Store alignment correct | H8 | CONFIRMED SAFE | INFO |
| H8-F3: `storage_path_to_felt252` base address correct | H8 | CONFIRMED SAFE | INFO |
| H8-F4: `u8` offset overflow in `_apply_write_once` | H8 | SUSPECTED | LOW |
| H8-F5: `MULTIPLE_DEPOSITORS` dead code | H8 | CONFIRMED | LOW |
| H8-F6: `UNEXPECTED_ZERO_VALUE` only checks `value[0]` | H8 | CONFIRMED | LOW |

---

## Top Confirmed Bugs

Ranked by confidence and potential impact:

1. **H7-BUG-01 — `add_balance` uses unchecked u128 addition (MEDIUM)**
   Real semantic bug: `subtract_balance` uses `checked_sub`, `add_balance` does not use `checked_add`.
   In production Cairo (release mode), overflow wraps silently. Practically infeasible for any
   standard ERC-20 token but a correctness defect that violates the contract's own defensive posture.
   Fix: use `checked_add` and introduce `errors::BALANCE_OVERFLOW`.

2. **H6-F4 — Withdrawal to contract's own address burns funds (LOW)**
   `WithdrawInputValid::assert_valid` permits `to_addr = get_contract_address()`. The resulting
   ERC-20 self-transfer leaves tokens permanently unclaimable through the privacy protocol.
   Only the caller's own funds are at risk. Fix: `assert(to_addr != get_contract_address(), ...)`.

3. **H5-F1 & H5-F2 — Missing `channel_key` non-zero validation in `UseNoteInputValid` and `OpenSubchannelInputValid` (LOW)**
   Both inputs silently accept zero `channel_key`, violating the documented invariant of the hash
   functions that consume it. The code fails safely with a misleading error. Fix: add a
   `ZERO_CHANNEL_KEY` assertion in both `assert_valid` implementations.

4. **H8-F5 — `MULTIPLE_DEPOSITORS` dead error constant (LOW)**
   Defined in `errors.cairo:54` but never referenced. Misleads auditors into thinking a
   multiple-depositor enforcement exists. Fix: remove or reintroduce the enforcement.

5. **H8-F6 — `_apply_write_once` zero-check only on `value[0]` (LOW)**
   Defense-in-depth gap; subsequent slots are unchecked by the write-once mechanism itself.
   Not exploitable in production due to the proof gate, but weakens the safety guarantee of
   the general-purpose mechanism.

6. **H8-F4 — `u8` offset overflow in `_apply_write_once` (LOW / SUSPECTED)**
   Code path exists and would be dangerous if reached. Not reachable in production because
   `apply_actions` requires a valid ZK proof committed to the exact `actions` payload.
   Worthwhile to add a bound check as defense-in-depth.
