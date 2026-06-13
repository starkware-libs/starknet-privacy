# Security Supervisor 1 — Verdict Report

Validation performed by reading the actual Cairo source files at the cited locations and independently reasoning through each claim.

---

## H1 — Hunter 1

### H1-F1: Cross-Transaction Open-Note Deposit Hijacking

**Verdict: CONFIRMED**
**Severity: HIGH**

Independently verified in `privacy.cairo` lines 790–830 (`_apply_actions`) and 885–915 (`_deposit_to_open_note`). The counter `undeposited_open_notes` is incremented by each `EmitOpenNoteCreated` event and decremented by `open_note_deposits.len()` returned from each `Invoke`. The final assertion at line 829 only checks that the counter reaches zero — it does not verify that any particular deposit targets a note created in the same transaction. `_deposit_to_open_note` checks only: `packed_value.is_non_zero()`, `salt == OPEN_NOTE_SALT`, `current_amount.is_zero()`, and `token == note_token`. There is no check binding the deposited note to the current transaction's `EmitOpenNoteCreated`. An attacker who plants note A in a prior transaction (with `current_amount == 0`) can, in a new transaction, emit `EmitOpenNoteCreated` for note B and then invoke an executor that returns a deposit targeting old note A. The counter arithmetic balances (1 created, 1 deposited), the transaction succeeds, note A is funded, and note B is left permanently stuck at `(OPEN_NOTE_SALT, 0)` — forever unusable because `UseNote` will revert with `ZERO_NOTE_AMOUNT_USAGE`. The test provided is logically correct and exercises the genuine code path. The attack requires the server/anonymizer to be malicious or misconfigured, but the contract itself offers no on-chain protection.

### H1-F2: TOO_MANY_OPEN_NOTES_DEPOSITED with Zero EmitOpenNoteCreated (Correctly Caught)

**Verdict: REJECTED (not a bug)**
**Severity: N/A**

Hunter 1 correctly identifies that this case is already protected. When there are zero `EmitOpenNoteCreated` actions and an Invoke deposits to a pre-existing open note, `checked_sub(0, 1)` underflows and panics with `TOO_MANY_OPEN_NOTES_DEPOSITED`. This is working as designed; the hunter correctly marks it N/A. No vulnerability.

---

## H2 — Hunter 2

### H2-F1: Double-Spend via Cross-Transaction WriteOnce (Not a Bug)

**Verdict: REJECTED (not a bug)**
**Severity: N/A**

Hunter 2 correctly analyzed this. `_apply_write_once` reads the on-chain storage slot before writing, and asserts it is zero (`storage_read_syscall(...).is_zero()` at line 841). If a nullifier was written by a prior transaction, the read returns non-zero and the assertion fails with `NON_ZERO_VALUE`. Double-spend is soundly prevented.

### H2-F2: Missing `channel_key != 0` Validation in `UseNoteInput::assert_valid`

**Verdict: CONFIRMED**
**Severity: LOW**

Verified in `actions.cairo` lines 175–179. The `UseNoteInputValid` implementation destructures the input as `UseNoteInput { channel_key: _, token, index: _ }` — the underscore pattern explicitly discards `channel_key` without checking it for zero. Only `token` is validated. Per the function contracts on `compute_note_id` and `compute_subchannel_marker` (both documented as assuming all inputs are non-zero), this violates the contract's own invariants. In practice, a `channel_key` of zero produces a well-defined but unexpected hash, and `subchannel_exists` will return false, causing `SUBCHANNEL_NOT_FOUND` before any real harm. This is a defensive validation gap — not exploitable today — but the missing check creates a documentation/implementation inconsistency and a latent risk. The severity is LOW, consistent with hunter's assessment.

### H2-F3: `use_note` Does Not Verify `derive_public_key(owner_private_key) == stored_public_key`

**Verdict: REJECTED (informational design note, not a bug)**
**Severity: INFO**

Verified in `privacy.cairo` lines 529–577. `use_note` derives `owner_public_key` from `owner_private_key`, computes `subchannel_marker` using that derived key, and checks `subchannel_exists`. For the attack to work (spending a legitimate note for address A), an adversary would need `derive_public_key(attacker_private_key) == pk_A`, which requires breaking the discrete log. The alternative path — where a sender opens a subchannel with a fake public key — only allows the sender to pre-commit to a channel only they can spend, harming only themselves. Hunter 2's own analysis is correct. The "missing check" creates no exploitable vulnerability in the current protocol. This is an informational design note at best.

---

## H3 — Hunter 3

### H3-F1: Stale Doc Reference to Non-Existent `VALUE_MISMATCH` Error

**Verdict: CONFIRMED**
**Severity: INFO**

Verified by examining both `interface.cairo` line 143–144 and `errors.cairo` in full. The doc comment on `compile_and_panic` states: `VALUE_MISMATCH: Thrown if the recipient's public key in storage does not match the provided public key`. This error constant does not exist anywhere in `errors.cairo` — confirmed by grep returning only the single interface doc comment. The `open_channel` implementation at lines 348–417 reads `recipient_public_key` from storage but never compares it to a user-supplied value (the struct has no such field). This is a documentation error from a prior design iteration that was not cleaned up. No runtime impact, but misleads auditors and integrators.

### H3-F2: `open_subchannel` Missing Explicit `recipient_public_key` Validation Against Storage

**Verdict: SUSPECTED**
**Severity: LOW**

Verified the code at lines 421–468. `open_subchannel` accepts `recipient_public_key` as a caller-supplied field and uses it only in computing `channel_marker`, then asserts the resulting marker exists in storage. There is no direct check `recipient_public_key == self.public_key.read(recipient_addr)`. The hunter's chain is correct: today, write-once public keys mean only the original registered key can produce a valid channel marker, so no exploitation path exists. However, the design asymmetry is real: `open_channel` reads `recipient_public_key` from storage (implicit validation), while `open_subchannel` trusts the caller to supply it and validates only indirectly via the channel marker hash. This is a latent risk that would become exploitable if key rotation were ever introduced. Verdict is SUSPECTED rather than CONFIRMED because the current protocol has no exploitation path — it is a design inconsistency with future-risk implications, not a present vulnerability.

### H3-F3: Index Skipping Attack (Not a Bug)

**Verdict: REJECTED (not a bug)**
**Severity: N/A**

Hunter 3 correctly determined this is not a bug. `_client_apply_actions` applies `WriteOnce` actions to storage within the same `compile_and_panic` call. After processing index=0, the outgoing channel for index=0 is written to storage. When index=2 is subsequently processed, the check for index=1 reads storage and finds nothing, reverting with `INDEX_NOT_SEQUENTIAL`. Correctly protected.

### H3-F4: Self-Channel and Self-Subchannel Are Permitted

**Verdict: REJECTED (by design, not a bug)**
**Severity: N/A**

Hunter 3 correctly identified this as intentional. Self-channels are the primary mechanism for a user to shield their own funds. No missing guard.

---

## H4 — Hunter 4

### H4-F1: `use_note` Compile Phase Skips Explicit Nullifier Check

**Verdict: REJECTED (not a bug)**
**Severity: INFO**

Hunter 4's own conclusion is correct. The spent-nullifier check is deferred to `_apply_write_once`, which reads the storage slot and asserts it is zero before writing. If the nullifier is already set from a prior transaction, the assertion fails. The only consequence of the "implicit" check design is a wasted L1 message on TOCTOU race (compile succeeds at T1, another tx spends the note before T3), which is a gas/UX concern, not a security failure. Not a bug.

### H4-F2: `compile_and_panic` Uses `ref self` — Fragile Safety via Runtime Invariant

**Verdict: CONFIRMED**
**Severity: LOW**

Verified in `privacy.cairo` lines 225–233. `compile_and_panic` is declared `ref self: ContractState` (mutable), while the comment at line 223–224 states it "ensures that the contract state cannot be modified by client's functions." The safety invariant depends entirely on the function always ending with `panic_with_server_actions`, which causes the entire call to revert, undoing writes. This is a type-system gap: the `@ContractState` (snapshot) type would make the immutability guarantee structural rather than runtime-behavioral. If a future refactor introduced a non-panicking early return (e.g., an early assertion before `main()` that returns instead of panicking), writes from `_client_apply_actions` would persist without the L1 message, silently breaking the compile-apply atomicity guarantee. This is a real design smell and low-severity fragility, though not currently exploitable.

### H4-F3: Signature Validated After `compile_actions` in `__execute__`

**Verdict: REJECTED (not a bug)**
**Severity: INFO**

Verified in `privacy.cairo` lines 184–201. `compile_actions` calls `compile_and_panic` via `call_contract_syscall` — an inner call that is fully sandboxed. When the inner call panics, all its storage writes are reverted. The outer call continues with only the panic data (serialized server actions). If `assert_valid_signature` then fails, the entire outer transaction reverts. No state from the compile phase persists. Reordering would be a gas optimization (reject invalid sigs before doing compile work) but is not a security requirement. Not a bug.

### H4-F4: `has_replay_protection` Excludes Deposit/Withdraw/InvokeExternal

**Verdict: REJECTED (not a bug)**
**Severity: N/A**

Verified in `privacy.cairo` lines 702–723. Only `WriteOnce` actions set `has_replay_protection = true`. Actions like `Deposit`, `Withdraw`, and `InvokeExternal` do not. This is intentional: any transaction containing only these actions would have no unique storage write, making it replayable. The design correctly requires at least one `WriteOnce`-producing action to guarantee uniqueness. This is a confirmed design feature, not a bug.

### H4-F5: Auditor Key Rotation Creates Irreversible Audit Gap

**Verdict: SUSPECTED**
**Severity: MEDIUM**

Verified in `privacy.cairo` lines 305–343 (`set_viewing_key`) and 987–990 (`set_auditor_public_key`). `set_viewing_key` reads `self.auditor_public_key.read()` at registration time and encrypts the user's private key to that key. There is no re-encryption or per-user key versioning. If `set_auditor_public_key` is called to rotate the auditor key, all pre-rotation users' `enc_private_key` values remain encrypted to the old key, permanently inaccessible to the new auditor. The `EncPrivateKey` struct embeds `auditor_public_key` to record which key was used, but there is no on-chain mechanism to trigger re-registration or re-encryption. The contract itself acknowledges this in interface documentation per the hunter. This is a genuine operational risk (not a code exploit), and the severity of "Medium" is appropriate given that a mistaken or malicious key rotation by the security governor permanently destroys audit coverage for all pre-rotation users with no recovery path in the contract. Verdict is SUSPECTED rather than CONFIRMED because the hunter identifies it as a "design concern" rather than a clear code bug, and whether it is a vulnerability depends on the threat model for the security governor role.

---

## Summary Table

| Finding | Hunter | Verdict | Severity |
|---------|--------|---------|----------|
| Cross-tx open-note deposit hijacking (note B stuck) | H1 | CONFIRMED | HIGH |
| Zero EmitOpenNoteCreated + Invoke deposit | H1 | REJECTED | N/A |
| Double-spend via cross-tx WriteOnce | H2 | REJECTED | N/A |
| Missing `channel_key != 0` in `UseNoteInput::assert_valid` | H2 | CONFIRMED | LOW |
| `use_note` does not verify registered public key | H2 | REJECTED | INFO |
| Stale `VALUE_MISMATCH` doc reference | H3 | CONFIRMED | INFO |
| `open_subchannel` missing explicit pk validation | H3 | SUSPECTED | LOW |
| Index skipping attack | H3 | REJECTED | N/A |
| Self-channel permitted | H3 | REJECTED | N/A |
| `use_note` compile skips explicit nullifier check | H4 | REJECTED | INFO |
| `compile_and_panic` uses `ref self` (fragile invariant) | H4 | CONFIRMED | LOW |
| Signature validated after `compile_actions` | H4 | REJECTED | INFO |
| `has_replay_protection` excludes Deposit/Withdraw | H4 | REJECTED | N/A |
| Auditor key rotation creates irreversible audit gap | H4 | SUSPECTED | MEDIUM |

---

## Top Confirmed Bugs

**1. H1-F1 — Cross-Transaction Open-Note Deposit Hijacking (HIGH)**

The most significant finding. `_deposit_to_open_note` has no check binding a deposit to a note created in the current transaction. A malicious or misconfigured server can redirect a deposit from a newly created note to any pre-existing undeposited open note. The newly created note is permanently stuck at `(OPEN_NOTE_SALT, 0)` and forever unusable. The counter arithmetic in `_apply_actions` passes because it only counts totals, not identities. Recommendation: track the set of `note_id`s created by `EmitOpenNoteCreated` in the current transaction and assert that each deposit targets a note from that set.

**2. H4-F2 — `compile_and_panic` Uses `ref self` Instead of `@ContractState` (LOW)**

`compile_and_panic` mutates state internally and relies on always panicking to revert those mutations. The type system provides no guarantee — the safety invariant is purely runtime-behavioral. A future refactor introducing a non-panicking early return would silently break compile-apply atomicity. Recommendation: change the signature to `self: @ContractState` if possible; if not, add a prominent architectural comment warning of this invariant.

**3. H2-F2 — Missing `channel_key != 0` in `UseNoteInput::assert_valid` (LOW)**

The validation explicitly discards `channel_key` with an underscore pattern, checking only `token`. This violates the function contracts of `compute_note_id` and `compute_subchannel_marker` (both assume non-zero inputs) and creates an inconsistency with other input validators. Easily fixed by adding `assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY)`.

**4. H3-F1 — Stale `VALUE_MISMATCH` Doc Comment in interface.cairo (INFO)**

The `compile_and_panic` error documentation references `VALUE_MISMATCH` for `OpenChannel`, but this error constant does not exist in `errors.cairo` and the corresponding check does not exist in `open_channel`. Misleads auditors. Easily fixed by removing the stale doc entry.
