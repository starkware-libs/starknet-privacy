# Starknet Privacy — Autonomous Security Audit Report

**Date:** 2026-06-13  
**Scope:** Cairo contracts in `packages/privacy`, `packages/ekubo_swap_anonymizer`, `packages/vesu_lending_anonymizer`  
**Method:** 16 parallel bug-hunter agents + 4 supervisor validation agents. Each bug independently confirmed against the actual source code.  
**Branch:** `claude/hopeful-goldberg-hvedmk`

---

## Executive Summary

The audit identified **2 HIGH**, **4 MEDIUM**, **10 LOW**, and **3 INFORMATIONAL** confirmed vulnerabilities across the privacy contract and the two DeFi anonymizer integrations.

The most critical issue is a **front-running fund-theft vector in the Ekubo swap anonymizer** (`privacy_invoke` has no access control). A second HIGH finding is a **cross-transaction open-note deposit hijacking bug** in the privacy contract core. Both are exploitable today and should be fixed before production deployment.

---

## Master Bug Table

| ID | Severity | Status | Title | Location |
|----|----------|--------|-------|----------|
| B-01 | **HIGH** | CONFIRMED | Unauthenticated `privacy_invoke` enables front-running fund theft | `ekubo_swap_anonymizer.cairo` |
| B-02 | **HIGH** | CONFIRMED | Cross-tx open-note deposit hijacking — new note permanently stuck | `privacy.cairo:790–915` |
| B-03 | MEDIUM | CONFIRMED | `DEPOSITOR_BLOCKED` bypassed when anonymizer returns empty deposits | `privacy.cairo:799–813` |
| B-04 | MEDIUM | CONFIRMED | Anonymizer block bypassed by redeployment at new address | `privacy.cairo:975–1022` |
| B-05 | MEDIUM | CONFIRMED | `add_balance` uses wrapping u128 addition (no overflow check) | `objects.cairo:13` |
| B-06 | MEDIUM | CONFIRMED | `check_ecdsa_signature` panics on zero public key (off-chain DoS) | `snip12.cairo:54` |
| B-07 | LOW | CONFIRMED | Missing `channel_key` non-zero check in `UseNoteInput::assert_valid` | `actions.cairo:175–179` |
| B-08 | LOW | CONFIRMED | Missing `channel_key` non-zero check in `OpenSubchannelInput::assert_valid` | `actions.cairo:68–78` |
| B-09 | LOW | CONFIRMED | Withdrawal to contract's own address permanently locks funds | `actions.cairo:195–203` |
| B-10 | LOW | CONFIRMED | `compile_and_panic` uses `ref self` — safety relies on runtime panic only | `privacy.cairo:225–233` |
| B-11 | LOW | CONFIRMED | Missing `out_token` zero check after pool-key derivation | `ekubo_swap_anonymizer.cairo:119–124` |
| B-12 | LOW | CONFIRMED | Dead `MULTIPLE_DEPOSITORS` error constant | `errors.cairo:54` |
| B-13 | LOW | CONFIRMED | `ephemeral_secret = curve_order` causes self-DoS panic | `utils.cairo:100–113` |
| B-14 | LOW | CONFIRMED | `pack()` missing runtime assertion for `value_1 < TWO_POW_120` | `utils.cairo:306–309` |
| B-15 | LOW | CONFIRMED | Vesu Withdraw assumes ERC-4626 owner==msg.sender allowance exemption | `vesu_lending_anonymizer.cairo:157–160` |
| B-16 | LOW | CONFIRMED | Vesu `out_amount` truncated to u128 (architectural ceiling) | `vesu_lending_anonymizer.cairo:164–167` |
| B-17 | INFO | CONFIRMED | Stale `VALUE_MISMATCH` doc reference (error does not exist) | `interface.cairo:143–144` |
| B-18 | INFO | CONFIRMED | Cross-layer ECDH y-coordinate convention undocumented | `utils.cairo:108`, `decryption.rs:41` |
| B-19 | INFO | CONFIRMED | `NOTE_ID_TAG` / `NULLIFIER_TAG` structural coupling — no cross-function test | `hashes.cairo:189–218` |

---

## B-01 — HIGH: Unauthenticated `privacy_invoke` Enables Front-Running Fund Theft

**File:** `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`

**Supervisors:** S4 CONFIRMED (adjudicated Hunter 13 vs Hunter 14; Hunter 13 correct)

**Description:**  
`privacy_invoke` captures `privacy_addr = get_caller_address()` and later issues `out_erc20.approve(spender: privacy_addr, amount: out_amount)`. There is no check that the caller is the privacy contract.

**Attack:**
1. Victim sends `in_token` to the anonymizer (pre-funding step before `apply_actions`).
2. Adversary observes the on-chain funding, calls `privacy_invoke` directly with valid swap params.
3. The swap executes: victim's `in_token` is consumed by the router.
4. `out_token` is approved to the adversary's address.
5. Adversary calls `transferFrom` to collect the swap output.
6. Victim's `apply_actions` finds the anonymizer unfunded and reverts. The `in_token` is gone permanently.

**Fix:** Add `assert(get_caller_address() == PRIVACY_CONTRACT_ADDRESS, errors::UNAUTHORIZED)` at the start of `privacy_invoke`. Alternatively, restructure `_apply_invoke` to atomically fund the anonymizer before the syscall, eliminating the pre-funding window.

---

## B-02 — HIGH: Cross-Transaction Open-Note Deposit Hijacking

**File:** `packages/privacy/src/privacy.cairo:790–915`

**Supervisors:** S1 CONFIRMED

**Description:**  
`_apply_actions` tracks `undeposited_open_notes` as a count of `EmitOpenNoteCreated` events vs. deposits returned by `Invoke`. The count check (`== 0` at end) verifies cardinality but not identity — it does not verify that each deposit targets a note created in the current transaction.

`_deposit_to_open_note` checks only: `packed_value.is_non_zero()`, `salt == OPEN_NOTE_SALT`, `current_amount.is_zero()`, `token == note_token`. No check binds the deposit to a current-tx note.

**Attack:**
1. Tx-A: Server plants open note A in storage (WriteOnce only, no deposit). Note A sits at `(OPEN_NOTE_SALT, 0)`.
2. Tx-B: Creates note B (`EmitOpenNoteCreated`, counter=1). Invoke returns a deposit targeting note A (not note B). Counter check: 1−1=0. Pass. Note A gets funded. Note B is left at `(OPEN_NOTE_SALT, 0)` forever.
3. `UseNote` on B reverts with `ZERO_NOTE_AMOUNT_USAGE`. The user loses access to the funds.

**Fix:** Maintain a `current_tx_open_notes: Felt252Dict<bool>` tracking note IDs emitted by `EmitOpenNoteCreated` in the current transaction. Assert in `_deposit_to_open_note` that `note_id` is in that set.

---

## B-03 — MEDIUM: `DEPOSITOR_BLOCKED` Bypassed When Anonymizer Returns Empty Deposits

**File:** `packages/privacy/src/privacy.cairo:799–813`

**Supervisors:** S4 CONFIRMED

**Description:**  
The `DEPOSITOR_BLOCKED` assertion is inside `if !open_note_deposits.is_empty()`. The `_apply_invoke` call runs unconditionally before this check. A blocked anonymizer returning `[]` executes all its DeFi logic (swaps, vault operations) without ever triggering `DEPOSITOR_BLOCKED`.

**Fix:** Move the blocked check before `_apply_invoke`:
```cairo
let open_note_depositor = input.contract_address;
assert(!self.blocked_depositors.read(open_note_depositor), errors::DEPOSITOR_BLOCKED);
let open_note_deposits = self._apply_invoke(:input);
```

---

## B-04 — MEDIUM: Anonymizer Block Bypassed by Redeployment

**File:** `packages/privacy/src/privacy.cairo:975–1022`

**Supervisors:** S4 CONFIRMED

**Description:**  
`blocked_depositors` maps contract addresses to bool. Both anonymizers have empty storage structs and parameter-free constructors. Deploying a bytecode-identical anonymizer at a new address bypasses the block. Per-user blocking is also impossible; blocking an anonymizer address affects all users of that anonymizer.

**Fix:** Document this limitation explicitly. Consider supplementing with off-chain monitoring or a merkle-root-based blocklist if user-level blocking is required.

---

## B-05 — MEDIUM: `add_balance` Uses Wrapping u128 Addition

**File:** `packages/privacy/src/objects.cairo:13`

**Supervisors:** S2 CONFIRMED (downgraded from HIGH)

**Description:**  
`add_balance` uses bare `+` operator: `current_balance + amount`. In Cairo's Sierra, u128 addition wraps on overflow. `subtract_balance` uses `checked_sub`, creating an asymmetry. An adversary controlling notes totaling ≥ u128::MAX (≈ 3.4×10^38) in raw token units could cause the balance to wrap, bypassing withdrawal limits.

Practically infeasible for standard ERC-20 tokens. Real for tokens with very small decimals (0–1) or very large supplies.

**Fix:**
```cairo
fn add_balance(ref self: TokenBalances, token: ContractAddress, amount: u128) {
    let (entry, current_balance) = self.entry(key: token.into());
    let new_value = current_balance.checked_add(amount).expect(errors::BALANCE_OVERFLOW);
    self = entry.finalize(new_value: new_value);
}
```
Add `pub const BALANCE_OVERFLOW: felt252 = 'BALANCE_OVERFLOW';` to `errors.cairo`.

---

## B-06 — MEDIUM: `check_ecdsa_signature` Panics on Zero Public Key (Off-Chain DoS)

**File:** `packages/privacy/src/snip12.cairo:54`

**Supervisors:** S3 CONFIRMED (MEDIUM off-chain, INFO on-chain)

**Description:**  
`verify_depositor_validation` calls `check_ecdsa_signature(message_hash, signer_public_key, r, s)` with no guard for `signer_public_key == 0`. Cairo's ECDSA VM builtin panics (not returns false) when given a zero public key, because address 0 is not a valid curve point. The function's documented error contract (`InvalidSignature` expected) is violated.

`snip12.cairo` is not used on-chain — it is exclusively called by the off-chain `elliptic-proxy` screening service. A zero-key input would crash the service rather than return a graceful error.

**Fix:**
```cairo
if signer_public_key == 0 {
    return Err(ValidationError::InvalidSignature);
}
```

---

## B-07 & B-08 — LOW: Missing `channel_key` Non-Zero Check in Input Validation

**File:** `packages/privacy/src/actions.cairo:175–179` (UseNoteInput), `68–78` (OpenSubchannelInput)

**Supervisors:** S1, S2, S3 all CONFIRMED (triple-confirmed across hunters 2, 5, 10)

**Description:**  
Both `UseNoteInputValid` and `OpenSubchannelInputValid` pattern-destructs `channel_key: _`, silently discarding it without a non-zero check. Hash functions that consume `channel_key` (`compute_note_id`, `compute_nullifier`, `compute_subchannel_marker`) document "assumes all inputs are non-zero." Zero `channel_key` fails safely but with misleading errors (`SUBCHANNEL_NOT_FOUND` or `INVALID_CHANNEL` instead of `ZERO_CHANNEL_KEY`).

**Fix:** Add to both `assert_valid` implementations:
```cairo
assert(channel_key.is_non_zero(), errors::ZERO_CHANNEL_KEY);
```
Add `pub const ZERO_CHANNEL_KEY: felt252 = 'ZERO_CHANNEL_KEY';` to `errors.cairo`.

---

## B-09 — LOW: Withdrawal to Contract's Own Address Permanently Locks Funds

**File:** `packages/privacy/src/actions.cairo:195–203`, `privacy.cairo:491–517`

**Supervisors:** S2 CONFIRMED

**Description:**  
`WithdrawInputValid::assert_valid` only checks `to_addr.is_non_zero()`. Setting `to_addr = get_contract_address()` produces a `TransferTo` that performs an ERC-20 self-transfer (contract sends tokens to itself). The ERC-20 balance is unchanged; the user's virtual balance is consumed. Tokens become permanently unclaimable through the privacy protocol.

**Fix:**
```cairo
assert(to_addr != get_contract_address(), errors::WITHDRAW_TO_SELF);
```

---

## B-10 — LOW: `compile_and_panic` Uses `ref self` — Fragile Safety Invariant

**File:** `packages/privacy/src/privacy.cairo:225–233`

**Supervisors:** S1 CONFIRMED

**Description:**  
`compile_and_panic` is declared `ref self: ContractState` (mutable). Safety relies on the function always panicking, which reverts all writes. The type system provides no guarantee. If a future refactor introduces a non-panicking early return, writes from `_client_apply_actions` would persist without the L1 message, silently breaking compile-apply atomicity.

**Fix:** Change to `self: @ContractState` if Cairo allows, or add a prominent architectural warning comment.

---

## B-11 — LOW: Missing `out_token` Zero Check in Ekubo Anonymizer

**File:** `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo:119–124`

**Supervisors:** S4 CONFIRMED

**Description:**  
`in_token` is checked non-zero, but `out_token` derived from the pool key is not. Supplying `pool_key.token1 = 0` with `in_token == pool_key.token0` produces `out_token = 0`. A dispatch to address 0 yields a non-descriptive low-level syscall failure instead of `ZERO_OUT_TOKEN`.

**Fix:**
```cairo
assert(out_token.is_non_zero(), errors::ZERO_OUT_TOKEN);
assert(out_token != in_token, errors::SAME_IN_OUT_TOKEN);
```

---

## B-12 — LOW: Dead `MULTIPLE_DEPOSITORS` Error Constant

**File:** `packages/privacy/src/errors.cairo:54`

**Supervisors:** S2, S4 CONFIRMED (doubly confirmed)

**Description:**  
`pub const MULTIPLE_DEPOSITORS: felt252 = 'MULTIPLE_DEPOSITORS'` is defined but never referenced. Suggests a removed or incomplete enforcement. Misleads auditors.

**Fix:** Remove the constant or implement the corresponding enforcement.

---

## B-13 — LOW: `ephemeral_secret = Curve Order` Causes Self-DoS Panic

**File:** `packages/privacy/src/utils.cairo:100–113`

**Supervisors:** S3 CONFIRMED

**Description:**  
The Stark curve group order `n = 0x0800000000000010fffffffe...` is a valid non-zero `felt252`. The `is_non_zero()` check passes. But `n * G` equals the identity point, causing `.try_into().expect(ZERO_EPHEMERAL_PUBLIC)` to panic. Affects all ECDH actions (`SetViewingKey`, `OpenChannel`, `Withdraw`, `CreateOpenNote`) when user sets `random = n`. Self-inflicted revert only; no state written.

**Fix:** Add `assert(random.into() < CURVE_ORDER, errors::INVALID_RANDOM)` to each `assert_valid` with a `random` field.

---

## B-14 — LOW: `pack()` Missing Runtime Assertion for `value_1 < TWO_POW_120`

**File:** `packages/privacy/src/utils.cairo:306–309`

**Supervisors:** S3 CONFIRMED

**Description:**  
`pack(value_1, value_2)` documents "assumes value_1 is 120 bits" but has no runtime enforcement. The `try_into().expect(PACK_OVERFLOW)` fires after the u256 is constructed, producing a misleading error. Current callers are all correct, but future callers could silently violate this.

**Fix:** Add `assert(value_1 < TWO_POW_120, internal_errors::PACK_OVERFLOW)` at the top of `pack`.

---

## B-15 — LOW: Vesu Withdraw Assumes ERC-4626 Owner==Sender Allowance Exemption

**File:** `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo:157–160`

**Supervisors:** S4 CONFIRMED

**Description:**  
The Withdraw path calls `vToken.withdraw(assets, receiver: self_addr, owner: self_addr)` with no preceding `approve`. This assumes Vesu's vToken complies with ERC-4626/SNIP-22 (which exempts `owner == msg.sender` from allowance). Low risk given documented compliance, but an integration assumption with no on-chain guard.

---

## B-16 — LOW: Vesu `out_amount` Truncated to u128

**File:** `packages/vesu_lending_anonymizer/src/vesu_lending_anonymizer.cairo:164–167`

**Supervisors:** S4 CONFIRMED

**Description:**  
`out_amount: u128 = (balance_after - balance_before).try_into().expect(RECEIVED_AMOUNT_OVERFLOW)`. The u128 ceiling (≈ 3.4×10^38) is not documented externally. For tokens with supply > u128::MAX, this will revert. Guard is correct but limitation is undocumented.

---

## B-17 — INFO: Stale `VALUE_MISMATCH` Doc Reference

**File:** `packages/privacy/src/interface.cairo:143–144`

**Supervisors:** S1 CONFIRMED

**Description:**  
`compile_and_panic` documentation references `VALUE_MISMATCH` as an error thrown by `OpenChannel` ("if the recipient's public key in storage does not match the provided public key"). This constant does not exist in `errors.cairo` and `OpenChannelInput` has no `recipient_public_key` field. Stale from a previous design iteration.

**Fix:** Remove the stale doc entry.

---

## B-18 — INFO: Cross-Layer ECDH y-Coordinate Convention Undocumented

**File:** `packages/privacy/src/utils.cairo:108`, `crates/discovery-core/src/privacy_pool/decryption.rs:41`

**Supervisors:** S3 CONFIRMED

**Description:**  
Cairo `EcPointTrait::new_from_x` and Rust `AffinePoint::new_from_x(..., false)` (even-y) use different y-coordinate conventions with no comment explaining why this is safe. The x-only ECDH invariant (`x-coord(r*P) = x-coord(r*(-P))`) makes them equivalent, but this is not documented. A future implementer could introduce a real bug trying to "fix" the apparent inconsistency.

**Fix:** Add a comment at each call site explaining the x-only ECDH property.

---

## B-19 — INFO: `NOTE_ID_TAG` / `NULLIFIER_TAG` Structural Coupling — No Cross-Function Test

**File:** `packages/privacy/src/hashes.cairo:189–218`

**Supervisors:** S3 CONFIRMED

**Description:**  
`compute_note_id` and `compute_nullifier` share structurally co-dependent layouts (same zero placeholder at position 4, explicitly documented). No test asserts `note_id != nullifier` for the same inputs. Tags are distinct so no collision exists, but the coupling is a maintenance risk.

**Fix:** Add a cross-function non-collision test.

---

## Suspected / Design Concerns (Not Confirmed Bugs)

| ID | Severity | Title | Location |
|----|----------|-------|----------|
| D-01 | MEDIUM | Auditor key rotation creates irreversible audit gap (no re-encryption path) | `privacy.cairo:987–990` |
| D-02 | LOW | `open_subchannel` missing explicit `recipient_public_key` validation against on-chain registry | `privacy.cairo:421–468` |
| D-03 | MEDIUM | Vesu anonymizer pre-funding design gap (not enforced; intended via TransferTo phase ordering) | `vesu_lending_anonymizer.cairo` |

---

## Findings by Component

| Component | HIGH | MEDIUM | LOW | INFO |
|-----------|------|--------|-----|------|
| `privacy.cairo` (core) | 1 | 2 | 4 | 1 |
| `objects.cairo` | 0 | 1 | 0 | 0 |
| `actions.cairo` | 0 | 0 | 3 | 0 |
| `errors.cairo` | 0 | 0 | 1 | 0 |
| `utils.cairo` | 0 | 0 | 2 | 1 |
| `hashes.cairo` | 0 | 0 | 0 | 1 |
| `snip12.cairo` | 0 | 1 | 0 | 0 |
| `ekubo_swap_anonymizer.cairo` | 1 | 0 | 1 | 0 |
| `vesu_lending_anonymizer.cairo` | 0 | 0 | 2 | 0 |
| `interface.cairo` | 0 | 0 | 0 | 1 |
| **Total** | **2** | **4** | **13** | **4** |

---

## Priority Fix List

1. **[B-01 HIGH]** Add caller authentication to `privacy_invoke` in `ekubo_swap_anonymizer.cairo`
2. **[B-02 HIGH]** Track `EmitOpenNoteCreated` note IDs and enforce identity match in `_deposit_to_open_note`
3. **[B-03 MEDIUM]** Move `DEPOSITOR_BLOCKED` check before `_apply_invoke` in `privacy.cairo`
4. **[B-05 MEDIUM]** Replace `+` with `checked_add` in `add_balance` in `objects.cairo`
5. **[B-07,B-08 LOW]** Add `ZERO_CHANNEL_KEY` assertion to `UseNoteInputValid` and `OpenSubchannelInputValid`
6. **[B-09 LOW]** Add `WITHDRAW_TO_SELF` guard in `WithdrawInputValid::assert_valid`
7. **[B-11 LOW]** Add `ZERO_OUT_TOKEN` and `SAME_IN_OUT_TOKEN` assertions in `ekubo_swap_anonymizer`
8. **[B-06 MEDIUM]** Add zero-key guard in `snip12.cairo` before `check_ecdsa_signature`
9. **[B-12 LOW]** Remove dead `MULTIPLE_DEPOSITORS` constant from `errors.cairo`
10. **[B-17 INFO]** Remove stale `VALUE_MISMATCH` doc entry from `interface.cairo`
