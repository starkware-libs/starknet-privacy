# Bug Hunter #6 Findings — Input Validation Audit

**Scope:** `CreateEncNoteInput`, `CreateOpenNoteInput`, `OpenSubchannelInput`, `WithdrawInput` in
`packages/privacy/src/actions.cairo` and related logic in `packages/privacy/src/privacy.cairo`.

---

## Finding 1: Zero-Amount Encrypted Note — Cannot Be Spent (Behavior Confirmed Correct)

**File:** `packages/privacy/src/privacy.cairo`, lines 605–609

**Claim to investigate:** Can a zero-amount enc note be created and later used to move value?

**Analysis:**

When `amount = 0`:
- `enc_amount = (hash.low + 0) % 2^128 = hash.low` (from `_encrypt_note_amount` in `utils.cairo:253`).
- `packed_value = pack(salt, enc_amount)`. Since `salt >= 2` (enforced by `SALT_TOO_SMALL`), the
  upper 120 bits of the packed u256 are non-zero, so `packed_value != 0`.
- The `assert(packed_value.is_non_zero(), internal_errors::ZERO_NOTE_VALUE)` check at line 607
  **passes** — the note IS written to storage successfully.

When the recipient later calls `use_note`:
- `decode_note_amount` is called: since `salt > OPEN_NOTE_SALT`, it calls `decrypt_note_amount`:
  `enc_amount.wrapping_sub(hash.low) = hash.low - hash.low = 0`.
- `assert(amount.is_non_zero(), errors::ZERO_NOTE_AMOUNT_USAGE)` fires and reverts.

**Verdict: Not a bug.** Zero-amount encrypted notes can be created (intentional, for reverted-index
recovery), but they can never be spent. The `ZERO_NOTE_AMOUNT_USAGE` guard in `use_note` is a
sound defense. The test at `test_client.cairo:2350` (`test_create_and_use_encrypted_note_zero_amount`)
confirms the expected behavior.

**Edge case note:** There is a negligible (1/2^128) probability that `enc_amount_hash.low == 0`
for a given `(channel_key, token, index, salt)` tuple, which would cause a zero-amount note to
produce `packed_value = pack(salt, 0)`. Since salt >= 2, the packed_value is still non-zero, so the
note is written — but on decrypt, `0 - 0 = 0`, and the note still fails `ZERO_NOTE_AMOUNT_USAGE`.
No practical risk.

---

## Finding 2: `recipient_public_key` in `OpenSubchannelInput` Is Not Validated as a Valid Curve Point

**File:** `packages/privacy/src/actions.cairo`, lines 68–78

**Severity: Low**

**Description:**

`OpenSubchannelInputValid::assert_valid` checks `recipient_public_key.is_non_zero()` but does NOT
validate that `recipient_public_key` is a valid x-coordinate on the Stark curve (i.e., that a curve
point with that x-coordinate exists). This contrasts with `set_auditor_public_key` in `privacy.cairo`
(lines 1027–1035), which calls `EcPointTrait::new_from_x(x: auditor_public_key).is_some()`.

**Impact:**

A sender can call `open_subchannel` with an arbitrary non-zero `recipient_public_key` that is not a
valid curve point. The subchannel will be created (marker stored), but the subchannel marker is:

```
subchannel_marker = h(SUBCHANNEL_MARKER_TAG, channel_key, recipient_addr, recipient_public_key, token)
```

The `channel_key` itself is computed by `_prepare_note_creation` from
`h(CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr, recipient_public_key)`.

If `recipient_public_key` does not correspond to any real user's private key, the subchannel will
be permanently inaccessible: `use_note` checks
`subchannel_exists[compute_subchannel_marker(channel_key, owner_addr, owner_public_key, token)]`,
where `owner_public_key = derive_public_key(owner_private_key)`. No honest user's `derive_public_key`
output will match a non-curve-point value, so notes placed into this subchannel are unspendable.

This is a **griefing vector**: a malicious sender can lock tokens in an unreachable subchannel by
specifying a forged `recipient_public_key`. The griefed tokens would be permanently trapped in the
contract. Note: the sender would also be depleting their own token balance (via
`token_balances.subtract_balance`), so the cost is borne by the attacker.

**Note:** The `open_channel` function (which must exist before `open_subchannel`) DOES pin
`recipient_public_key` to the registry value read from `self.public_key.read(recipient_addr)`.
However, `open_subchannel` accepts the public key as a caller-supplied parameter and only validates
it via the `channel_exists` check. If someone somehow has a subchannel pre-existing from a valid
channel but then calls `open_subchannel` for a new subchannel on a different channel (with a
fabricated key), the channel marker check prevents it. But if the channel was opened legitimately
and the sender now crafts a new subchannel with a forged `recipient_public_key` that happens to
pass a channel_marker check — actually this cannot happen because `channel_marker` includes
`recipient_public_key` and the real one was stored. So the real attack surface is narrower.

The actual risk is: a sender opens a real channel, then opens a subchannel with the REAL
`recipient_public_key` from the channel, but fabricates notes into a subchannel with a DIFFERENT
`recipient_public_key`. The `_prepare_note_creation` call in `create_enc_note` independently
computes `channel_key` and then checks the subchannel marker. If the sender uses a `recipient_public_key`
that differs from the one in the real subchannel, the `SUBCHANNEL_NOT_FOUND` check will catch it.
So the actual attack is confined to: creating a subchannel with an invalid public key on a valid
channel. The channel marker check uses `recipient_public_key` from the input, and since the real
channel used the registered public key, a fake public key would fail `channel_exists`. This closes
the loop.

**Revised verdict: Not exploitable under the current channel-existence check**, because `open_channel`
pins `recipient_public_key` to the on-chain registry and `open_subchannel`'s `INVALID_CHANNEL`
check transitively enforces this binding. The non-validation in `assert_valid` is a defense-in-depth
gap but not an exploitable bug.

---

## Finding 3: Self-Subchannel — No Restriction on `recipient_addr == sender_addr` (Informational)

**File:** `packages/privacy/src/actions.cairo`, lines 68–78; `privacy.cairo` lines 421–468

**Severity: Informational**

**Description:**

Neither `OpenSubchannelInput::assert_valid` nor `open_subchannel` prevents `recipient_addr ==
sender_addr` (a self-directed subchannel). The tests (`test_client.cairo:196–237`) demonstrate that
self-channels and self-subchannels are used intentionally (e.g., `user_1.open_channel_with_token_e2e(recipient: user_1, ...)`).

**Privacy analysis:**

When `sender_addr == recipient_addr` and `sender_private_key` corresponds to `recipient_public_key`
(i.e., the same user registered their own key), the `channel_key` is:
```
h(CHANNEL_KEY_TAG, user_addr, user_private_key, user_addr, user_public_key)
```
This is deterministically derived from the user's own credentials and known only to them. The
subchannel marker then ties to this channel key together with their own addr/public_key, creating a
fully private self-channel.

**Verdict: Not a bug.** Self-subchannels are an intentional design feature enabling users to
store notes to themselves (e.g., as change outputs in a transfer). The `test_transfer_to_self`
test at line 196 confirms this is tested and expected.

---

## Finding 4: `WithdrawInput` — Withdrawal to Privacy Contract's Own Address

**File:** `packages/privacy/src/actions.cairo`, lines 195–203; `privacy.cairo` lines 491–517

**Severity: Low**

**Description:**

`WithdrawInput::assert_valid` only checks `to_addr.is_non_zero()`. A user can withdraw to ANY
non-zero address, including the privacy contract's own address (`get_contract_address()`). When
`to_addr == privacy_contract_address`:

1. `_apply_transfer_to` calls `checked_transfer(token_address: token, recipient: privacy_contract_address, amount: ...)`.
2. This is an ERC-20 `transfer` from the contract to itself, which succeeds (the contract holds the
   balance).
3. The net effect: the token balance does NOT leave the contract — it stays in the contract's ERC-20
   balance.
4. However, from the privacy protocol's perspective, the user's internal virtual balance IS reduced
   (via `token_balances.subtract_balance`), and the `EmitWithdrawal` event fires with the
   encrypted `enc_user_addr` and the visible `to_addr = privacy_contract_address`.
5. The accounting difference: the ERC-20 balance of the contract stays the same but the user's
   note/balance is consumed. The contract now holds more ERC-20 balance than is accounted for by
   the sum of outstanding notes — the "surplus" tokens become unclaimable by any user.

**Impact:**

- **Funds are effectively burned:** The tokens remain in the contract's ERC-20 balance but are no
  longer attributable to any privacy note or balance. Other users' funds are not harmed (their
  notes are still redeemable), but the withdrawn amount is permanently locked.
- **Griefing potential:** A malicious user can permanently destroy their own tokens this way,
  polluting the event log and causing an ERC-20 balance surplus that cannot be explained by normal
  protocol accounting.
- **No theft:** Other users cannot access the surplus tokens via the privacy protocol.

**Recommendation:** Add a check in `WithdrawInputValid::assert_valid` or in `withdraw()`:
```cairo
assert(to_addr != get_contract_address(), errors::WITHDRAW_TO_SELF);
```

---

## Finding 5: `_prepare_note_creation` — Caller-Supplied `recipient_public_key` Not Cross-Checked with Registry

**File:** `packages/privacy/src/privacy.cairo`, lines 661–700

**Severity: Informational**

**Description:**

In `_prepare_note_creation`, the `channel_key` is computed from the caller-supplied
`recipient_public_key` parameter without checking that it matches `self.public_key.read(recipient_addr)`.
The correctness is enforced transitively: the subchannel_marker check requires the subchannel to
have been established by `open_subchannel`, which required a valid channel via `open_channel`, which
pinned `recipient_public_key` to the registry.

**Verdict: Not a bug under current design** (immutable keys). The chain of checks is sound. If key
rotation were ever introduced, this would need revisiting.

---

## Finding 6: `CreateOpenNoteInput` — Zero-Deposit Correctly Rejected

**File:** `packages/privacy/src/actions.cairo`, lines 119–144; `privacy.cairo` lines 884–915

**Description:**

Open notes have no `amount` field in `CreateOpenNoteInput`; they receive whatever the Invoke action
deposits. A zero-amount deposit is rejected at `_deposit_to_open_note` line 890:
`assert(amount.is_non_zero(), errors::ZERO_AMOUNT)`. An undeposited open note causes
`UNDEPOSITED_OPEN_NOTES` to fire at the end of `_apply_actions` (line 829).

**Verdict: Not a bug.** Zero-deposit to an open note is correctly rejected.

---

## Finding 7: `CreateEncNoteInput` — Missing `amount` in `assert_valid` Signature Matches Intent

**File:** `packages/privacy/src/actions.cairo`, lines 103–117

**Description:**

The `assert_valid` implementation pattern-destructs `amount: _` (line 106), intentionally skipping
validation of `amount`. This is correct by design — zero amount is allowed for reverted-index
recovery. The comment at line 108–109 documents this explicitly.

**Verdict: Not a bug.** The design is intentional and documented.

---

## Summary Table

| # | Finding | Severity | Verdict |
|---|---------|----------|---------|
| 1 | Zero-amount enc note cannot be spent | N/A | Non-issue, correctly handled |
| 2 | `recipient_public_key` not curve-validated in `open_subchannel` | Low | Not exploitable — `channel_exists` check closes loop |
| 3 | Self-subchannel allowed | Informational | Intentional design |
| 4 | `WithdrawInput.to_addr` can be the contract's own address | Low | **Real issue — funds burned, griefing possible** |
| 5 | `recipient_public_key` not cross-checked with registry in note creation | Informational | Non-issue under immutable keys |
| 6 | Zero-deposit to open note correctly rejected | N/A | Non-issue |
| 7 | Zero `amount` skipped in `CreateEncNoteInput::assert_valid` | N/A | Intentional by design |

---

## Actionable Bug

### Bug: Withdrawal to Contract's Own Address Permanently Locks Funds

**Location:** `packages/privacy/src/actions.cairo:195–203` (`WithdrawInputValid::assert_valid`)
and `packages/privacy/src/privacy.cairo:491–517` (`withdraw`)

**Description:** `to_addr` is only checked to be non-zero, allowing a user to withdraw tokens to
the privacy contract itself. This results in a no-op ERC-20 self-transfer: the contract's total
ERC-20 balance is unchanged, but the user's virtual balance (and any associated notes) is
consumed. The tokens become permanently unclaimable through the privacy protocol — effectively
burned. An attacker could use this to discard funds in a way that makes it look like a normal
withdrawal on-chain (the `EmitWithdrawal` event fires), potentially confusing off-chain analytics.

**Proposed fix:**
```cairo
// In WithdrawInputValid::assert_valid or in withdraw():
assert(to_addr != get_contract_address(), errors::WITHDRAW_TO_SELF);
```
