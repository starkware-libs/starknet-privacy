# Supervisor 4 — Verdict Report

Hunters 13, 14, 15, and 16. Topics: cross-contract token flows, interface consistency, ECDH
encryption, and `_apply_write_once`.

---

## Summary Table

| Hunter | Finding | Severity Claimed | Verdict | Supervisor Severity |
|--------|---------|-----------------|---------|---------------------|
| 13 | F1: Stranded vTokens enable cross-user theft | HIGH | CONFIRMED | HIGH |
| 13 | F2: `clear(in_token)` semantics mismatch — misleading variable | MEDIUM | INFORMATIONAL | INFORMATIONAL |
| 13 | F3: Ekubo `in_amount` not validated against tokens received | MEDIUM | CONFIRMED | LOW |
| 14 | F1: Vesu Withdraw strands excess vTokens (no recovery) | MEDIUM | CONFIRMED | MEDIUM |
| 14 | F2: `note_id` user-controlled, no commitment binding | LOW | INFORMATIONAL | INFORMATIONAL |
| 14 | F3: `undeposited_open_notes` counter semantics | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |
| 14 | F4: Anonymizers don't validate caller is privacy contract | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |
| 14 | F5: `clear_minimum` return value silently ignored | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |
| 15 | F1: ECDH y-coordinate ambiguity in decryption | MEDIUM | REJECTED | — |
| 15 | F2: `is_canonical_key(0)` returns true | LOW | INFORMATIONAL | INFORMATIONAL |
| 15 | F3: HALF_ORDER boundary key excluded (off-by-one) | NEGLIGIBLE | INFORMATIONAL | INFORMATIONAL |
| 15 | F4: `ephemeral_secret` reuse not enforced on-chain | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |
| 15 | F5: Outgoing channel info uses symmetric key, not ECDH | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |
| 16 | F1: WriteOnce interior zero slot bypasses idempotency | LOW-MEDIUM | INFORMATIONAL | INFORMATIONAL |
| 16 | F2: Interleaved check-then-write cannot produce partial state | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |
| 16 | F3: `create_enc_note` single-slot write is intentional | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |
| 16 | F4: `validate_proof` recency checks are correct | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |
| 16 | F5: `collect_fee` caller-pull pattern is correct | INFORMATIONAL | INFORMATIONAL | INFORMATIONAL |

---

## Detailed Analysis

### Hunter 13, Finding 1 — Stranded vTokens Enable Cross-User Theft

**Verdict: CONFIRMED (HIGH)**

**Code traced:**

`vesu_lending_anonymizer.cairo:157-161`:
```cairo
LendingOperation::Withdraw => {
    IVTokenDispatcher { contract_address: in_token }
        .withdraw(:assets, receiver: self_addr, owner: self_addr)
},
```

The Vesu ERC-4626 `withdraw(assets, receiver, owner)` burns *exactly enough shares to produce
`assets` of underlying*. The share price changes block-to-block as interest accrues. If the user
computed "I need to send `shares_A` to withdraw `assets_A`" at block T, but the tx executes at
block T+N when 1 share now redeems more underlying, then `burned_shares < shares_A` and
`leftover = shares_A - burned_shares` remains in the anonymizer.

The anonymizer has no storage and no sweep function. The leftover vTokens sit in its ERC20
balance indefinitely.

**The theft path is real and requires no privileged access:**

1. After User A's tx completes, the anonymizer holds `leftover` vTokens. This is readable via
   `IERC20.balanceOf(anonymizer)`.
2. User B creates a valid open note for the underlying token (legitimate protocol action).
3. User B constructs a `privacy_invoke(Withdraw, in_token=vToken, out_token=underlying,
   assets = convertToUnderlying(shares_B + leftover), note_id=B_note)`.
4. The privacy system processes `TransferTo(anonymizer, vToken, shares_B)` first (in the same
   `_apply_actions` call), giving the anonymizer `shares_B + leftover` total vTokens.
5. `privacy_invoke` calls `withdraw(assets_B_plus_leftover, self_addr, self_addr)`. The vault
   burns `shares_B + leftover` (all of them). The anonymizer receives
   `underlying_B_plus_leftover`.
6. `out_amount = balance_after - balance_before = underlying_B_plus_leftover` (full amount).
7. The anonymizer approves User B for `out_amount`. User B's open note is credited the full
   amount, which is more than User B contributed.

User B has stolen `convertToUnderlying(leftover)` from User A at cost of only a transaction fee.

**Attack is achievable through normal protocol usage.** All three prerequisites (public balance
knowledge, correct `assets` parameter, valid open note) are routine.

Hunter 14 correctly identified the stranding mechanism; Hunter 13 correctly extends this to the
theft vector. Both reports are accurate. The combined issue is a high-severity vulnerability.

---

### Hunter 13, Finding 2 — `clear(in_token)` Semantics Mismatch

**Verdict: INFORMATIONAL**

**Code traced (`ekubo_swap_anonymizer.cairo:139-142`):**
```cairo
let in_token_remaining = clear
    .clear(token: EkuboIERC20Dispatcher { contract_address: in_token });
assert(in_token_remaining.is_zero(), errors::IN_TOKEN_NOT_CLEARED);
```

Hunter 13 is correct that the variable name is misleading: `clear` sweeps the router's balance
*to the caller* and returns the swept amount, not what "remains" on the router. If the return is
nonzero, the assertion fires and the entire transaction reverts, undoing the transfer. No tokens
are stranded.

However, the security behavior is correct end-to-end. The revert semantics ensure no partial fill
survives. The concern is purely about the variable name misleading future maintainers. There is no
currently exploitable condition, and the revert removes even the transient intermediate state.

Severity: INFORMATIONAL. The rename suggestion is good hygiene.

---

### Hunter 13, Finding 3 — Ekubo `in_amount` Not Validated Against Tokens Received

**Verdict: CONFIRMED (LOW)**

**Code traced (`ekubo_swap_anonymizer.cairo:130-132`):**
```cairo
checked_transfer(
    token_address: in_token, recipient: router_addr, amount: in_amount.into(),
);
```

The `in_amount` here comes from the user's calldata passed to `privacy_invoke`. The privacy
contract enforces via `token_balances` that the total tokens *withdrawn from the privacy pool*
match what the server actions account for. However, the `InvokeExternal` calldata is opaque to the
privacy contract — it is forwarded verbatim. If the user specifies `in_amount` in the Ekubo
calldata smaller than the actual amount withdrawn from their note, the difference strands in the
anonymizer and is susceptible to the same cross-user consumption described in Finding 1 (though
for in_token rather than vTokens).

This is a real structural issue: there is no on-chain check that the `in_amount` in the Ekubo
calldata matches the amount the privacy contract transferred to the anonymizer. The attack requires
a user to deliberately miscalibrate their own calldata, which harms only themselves or slightly
benefits a subsequent user — making this lower severity than Finding 1 (where the mismatch arises
passively from interest accrual). Severity: LOW.

---

### Hunter 14, Finding 1 — Stranded vTokens (No Recovery Path)

**Verdict: CONFIRMED (MEDIUM)**

This is the same root cause as Hunter 13 Finding 1. Hunter 14's framing focuses on the loss to
the original user (funds permanently stuck), while Hunter 13 finds the active theft. Both aspects
are real. As the standalone "stuck funds" finding without the theft dimension, this merits MEDIUM.
Together with Hunter 13 Finding 1, the combined issue is HIGH.

---

### Hunter 14, Finding 2 — `note_id` User-Controlled, No Commitment Binding

**Verdict: INFORMATIONAL**

Verified in `_deposit_to_open_note` (`privacy.cairo:944-973`): every invalid `note_id` value
produces a clear revert (`NOTE_NOT_FOUND`, `NOTE_NOT_OPEN`, `TOKEN_MISMATCH`). The user cannot
direct funds to another user's open note because open note IDs are derived from a private
`channel_key` unknown to anyone else. No exploitable path exists.

---

### Hunter 14, Findings 3-5 — Informational Items

**Verdict: INFORMATIONAL (all three)**

Finding 3 (`undeposited_open_notes` counter): The counter logic at `privacy.cairo:842-857` is
correct. `checked_sub` prevents depositing to more notes than were created; the final assert at
line 857 prevents fewer. Sound.

Finding 4 (caller not validated): The approve-and-transferFrom pattern means the caller receives
approval only for what the anonymizer computed. Without the privacy contract also being the caller,
the attack would require the adversary to have pre-deposited tokens in the anonymizer and have
already satisfied the `balance_before`/`balance_after` accounting. The design is intentional and
the risk is bounded.

Finding 5 (`clear_minimum` return value): The comment at `ekubo_swap_anonymizer.cairo:144-146`
acknowledges this explicitly. The `balance_after - balance_before` measurement is the correct way
to capture the output. No bug.

---

### Hunter 15, Finding 1 — ECDH y-Coordinate Ambiguity

**Verdict: REJECTED**

Hunter 15 self-corrects within the finding: the mathematical analysis shows both encryption and
decryption arrive at the same shared x-coordinate regardless of which y the curve point recovery
picks, because negating a point preserves its x-coordinate. The hunter labels this "CONFIRMED BUG"
in the heading but then proves there is no bug in the body. The implementation is correct.

**Encryption side (`utils.cairo:112-114`):**
- `new_from_x(public_key)` returns either `K` or `-K`.
- `ephemeral_secret * K` and `ephemeral_secret * (-K) = -(ephemeral_secret * K)` have the same
  x-coordinate.
- `shared_x` is unambiguous.

**Decryption side (`_find_shared_x` in test utilities):**
- `new_from_x(ephemeral_pubkey)` returns either `R` or `-R`.
- `private_key * R` and `private_key * (-R)` have the same x-coordinate.
- Decryption recovers the same `shared_x` as encryption.

ECDH is mathematically sound. REJECTED.

---

### Hunter 15, Finding 2 — `is_canonical_key(0)` Returns True

**Verdict: INFORMATIONAL**

**Code traced (`utils.cairo:240-242`):**
```cairo
pub(crate) fn is_canonical_key(key: felt252) -> bool {
    key.into() < HALF_ORDER
}
```

`HALF_ORDER` is a positive u256 value, so `0 < HALF_ORDER` is true and `is_canonical_key(0)`
returns true.

**However, the only production call site is `privacy.cairo:256-257`:**
```cairo
assert(user_private_key.is_non_zero(), errors::ZERO_PRIVATE_KEY);
assert(is_canonical_key(key: user_private_key), errors::PRIVATE_KEY_NOT_CANONICAL);
```

The `is_non_zero()` check runs *first*. Key = 0 is caught before `is_canonical_key` is ever
reached in production code. The function is also called in test utilities (`utils_for_tests.cairo`
lines 1161 and 1401) to filter test private keys, where zero keys would naturally be excluded by
the context.

The semantic gap is real (the function's name implies it validates canonical private keys, but
silently accepts 0), and could mislead a future caller who calls `is_canonical_key` without the
companion `is_non_zero` guard. This is a latent API design issue with no current exploitability.
INFORMATIONAL.

---

### Hunter 15, Finding 3 — HALF_ORDER Boundary Excluded

**Verdict: INFORMATIONAL**

The exclusion of exactly `HALF_ORDER` (one key out of ~2^251) is a negligible off-by-one. Because
the Stark curve order is odd, `floor(ORDER/2)` and `ceil(ORDER/2)` differ by 1. The strict `<`
check consistently rejects one boundary value. This is a documentation issue, not a security
issue. INFORMATIONAL.

---

### Hunter 15, Findings 4-5 — Design Observations

**Verdict: INFORMATIONAL (both)**

Finding 4 (`ephemeral_secret` reuse): Correct observation. The contract enforces only
`random.is_non_zero()`. Reuse would leak that two channel openings share the same ephemeral key,
which is a privacy degradation not a security break. By design; INFORMATIONAL.

Finding 5 (outgoing channel info uses symmetric key): Correctly characterized as intentional
asymmetry in the auditor model. INFORMATIONAL.

---

### Hunter 16, Finding 1 — WriteOnce Interior Zero Slot Bypasses Idempotency

**Verdict: INFORMATIONAL**

Hunter 16 claims that a zero interior slot (e.g. `enc_recipient_addr = 0` in slot 1) allows a
second WriteOnce call to bypass idempotency for that slot.

**Code traced (`privacy.cairo:891-906`):**
```cairo
fn _apply_write_once(ref self: ContractState, input: WriteOnceInput) {
    let WriteOnceInput { storage_address, value } = input;
    assert(!value.is_empty(), internal_errors::UNEXPECTED_EMPTY_VALUE);
    assert(value[0].is_non_zero(), internal_errors::UNEXPECTED_ZERO_VALUE);
    let base: StorageBaseAddress = storage_base_address_from_felt252(addr: storage_address);
    let mut offset = 0;
    for felt in value {
        let address = storage_address_from_base_and_offset(:base, :offset);
        assert(
            storage_read_syscall(address_domain: 0, :address).unwrap_syscall().is_zero(),
            errors::NON_ZERO_VALUE,
        );
        storage_write_syscall(address_domain: 0, :address, value: *felt).unwrap_syscall();
        offset += 1;
    }
}
```

For `EncOutgoingChannelInfo { salt=nonzero, enc_recipient_addr=0 }`, the two slots are:
- slot 0 = `salt` (nonzero)
- slot 1 = `enc_recipient_addr` (zero)

On a second WriteOnce attempt for the same `storage_address`:
- At offset=0: `storage_read_syscall` returns `salt` (nonzero) → `is_zero()` is false →
  **assert fires with `NON_ZERO_VALUE`**. The transaction reverts before reaching slot 1.

Hunter 16's claim that "a second call finds the slot is still zero" is wrong for slot 1 — the
second call never reaches slot 1 because it fails on slot 0. The idempotency protection is
correctly enforced for this specific scenario via slot 0 alone.

The data integrity problem is real: if `enc_recipient_addr` is zero (probability ~2^{-251}), the
stored outgoing channel record is corrupted (the recipient address cannot be recovered). But this
is a purely data-correctness concern at astronomically low probability, not a security issue.
There is no replay, no theft, and no bypass of the WriteOnce invariant that could be exploited.

The theoretical bypass Hunter 16 describes would only occur if slot 0 were also zero, which is
prevented by the pre-loop `assert(value[0].is_non_zero(), ...)`. INFORMATIONAL.

---

### Hunter 16, Findings 2-5 — Informational Items

**Verdict: INFORMATIONAL (all four)**

Finding 2 (interleaved check-then-write atomicity): Correctly analyzed. Starknet transaction
atomicity means a panic on slot N reverts all prior writes including slot 0. No partial state.

Finding 3 (`create_enc_note` single-slot write): Correctly analyzed. Intentional design; the
`packed_value` slot is the only one written. The zero-token field for encrypted notes is load-
bearing by design.

Finding 4 (`validate_proof` recency checks): Correctly analyzed. The strict lower bound and upper
bound are both correct.

Finding 5 (`collect_fee` caller-pull pattern): Correctly analyzed. If the server did not pre-
approve, the tx reverts. Correct safe-failure mode.

---

## Notable Cross-Hunter Observations

**Hunter 13 Finding 1 and Hunter 14 Finding 1 are two facets of the same vulnerability.** Hunter
14 found the mechanism (stranding); Hunter 13 found the exploit (theft). Both should be reported
as a single HIGH issue. The root causes are identical:
1. The Vesu Withdraw path burns shares by `assets` amount, not by `shares sent` amount.
2. The anonymizer is stateless and holds a global undifferentiated token balance.
3. No sweep mechanism exists after the vault operation.

The most practical mitigation is for the anonymizer to transfer any remaining `in_token` balance
back to `privacy_addr` after the vault call, combined with passing the exact `in_amount`
(shares sent) through calldata so the anonymizer can verify `burned == in_amount`.

**Hunter 15 Finding 1 is self-contradictory.** The hunter labels the finding "CONFIRMED BUG" in
the heading, then proves in the body that it is not a bug. The mathematical analysis is correct;
the label is wrong. No action required on the code.

**Hunter 16 Finding 1** misidentifies the failure mode. The zero-slot bypass described does not
occur because slot 0 (always nonzero, enforced by the pre-loop assert) blocks any replay. The
data integrity concern at 2^{-251} probability is real but inconsequential.
