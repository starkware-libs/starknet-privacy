# Supervisor #1 — Audit Verdict

**Files audited:** hunter-1.md, hunter-2.md, hunter-6.md, hunter-7.md, hunter-11.md, hunter-12.md, hunter-14.md

> Note: The prompt referenced hunters 3 and 4; those files were not present in the repository. The available hunter reports are numbered 1, 2, 6, 7, 11, 12, and 14. All were read and verified.

---

## Summary Table

| Hunter | Finding | Verdict | Severity |
|--------|---------|---------|----------|
| H1-1 | Token balance overflow on multi-note u128 addition | CONFIRMED | Low |
| H1-2 | `InvokeExternal`-only tx rejected with `NO_REPLAY_PROTECTION` | INFORMATIONAL | Info |
| H1-3 | Duplicate `SetViewingKey` fails on `NON_ZERO_VALUE` internal error | INFORMATIONAL | Info |
| H2-1 | `sender_private_key` in `compute_enc_recipient_addr_hash` — brute-force oracle | REJECTED (severity overblown) | Info |
| H2-2 | Missing cross-function hash collision tests | INFORMATIONAL | Info |
| H2-3 | Undocumented zero placeholder in `compute_enc_token_hash` | INFORMATIONAL | Info |
| H2-4 | Storage key collisions between Maps | REJECTED (confirmed safe) | None |
| H2-5 | `compute_outgoing_channel_id` as private-key brute-force oracle | REJECTED (severity overblown) | Info |
| H6-1 | Enc note leaves `token` slot zero — implicit storage contract | INFORMATIONAL | Info |
| H6-2 | `_prepare_note_creation` does not verify `sender_private_key` — breaks auditor | CONFIRMED | Medium |
| H6-3 | `create_open_note` silently discards `channel_key` | INFORMATIONAL | Info |
| H6-4 | `create_open_note` has no salt — weaker privacy on retried transactions | INFORMATIONAL | Info |
| H6-5 | `index - 1` underflow guarded by short-circuit only — fragile | INFORMATIONAL | Info |
| H6-6 | Zero-amount enc note consumes index permanently | INFORMATIONAL | Info |
| H6-7 | `open_subchannel` does not explicitly verify `recipient_public_key` against registry | INFORMATIONAL | Info |
| H7-1 | Self-invocation of privacy contract via `_apply_invoke` | REJECTED (confirmed safe) | None |
| H7-2 | Re-entrancy guard covers `_apply_invoke` callback | REJECTED (confirmed safe) | None |
| H7-3 | `_deposit_to_open_note` before `checked_sub` — depends on Cairo panic semantics | INFORMATIONAL | Info |
| H7-4 | `undeposited_open_notes` is transaction-scoped; cross-tx deposits impossible | INFORMATIONAL | Info |
| H7-5 | Multiple `Invoke` server actions unrestricted at server layer | INFORMATIONAL | Info |
| H7-6 | `InvokeExternalInput` calldata unchecked in length | INFORMATIONAL | Info |
| H11-1 | Residual `in_token` approval after deposit never cleared | CONFIRMED | Low |
| H11-2 | Stranded `in_token` balance when `assets < anonymizer_balance` | SUSPECTED | Medium |
| H12-1 | Core withdraw flow is correct | REJECTED (confirmed safe) | None |
| H12-2 | `assets > u128::MAX` causes `RECEIVED_AMOUNT_OVERFLOW` | INFORMATIONAL | Info |
| H12-3 | No caller authentication on `privacy_invoke` | CONFIRMED | Low |
| H14-1 | Vesu Withdraw strands excess vTokens in anonymizer | CONFIRMED | Medium |
| H14-2 | `note_id` is user-controlled with no commitment binding | INFORMATIONAL | Info |
| H14-3 | `undeposited_open_notes` counter semantics | REJECTED (confirmed safe) | None |
| H14-4 | Neither anonymizer validates caller is privacy contract | CONFIRMED (duplicate of H12-3) | Low |
| H14-5 | Ekubo `clear_minimum` return value ignored | REJECTED (confirmed safe) | None |

---

## Hunter 1 Detailed Analysis

### H1-1: Token balance overflow on multi-note u128 addition — CONFIRMED / Low

**Trace:** `TokenBalancesImpl::add_balance` at `objects.cairo:12–13`:
```cairo
fn add_balance(ref self: TokenBalances, token: ContractAddress, amount: u128) {
    let (entry, current_balance) = self.entry(key: token.into());
    self = entry.finalize(new_value: current_balance + amount);
}
```
The `+` on `u128` panics on overflow in Cairo (no wrap). The hunter is correct: two notes each
with `amount = u128::MAX/2 + 1` for the same token would cause a panic in `main` during the token
balance accumulation phase, before reaching the `NEGATIVE_INTERMEDIATE_BALANCE` check.

**Impact assessment:** The hunter's severity call (Low) is correct. In practice, no real ERC-20 has
a total supply near `u128::MAX`, so this is a theoretical edge case. The bug is real but practically
unexploitable with any production token. The stated correctness issue is valid: the documented error
path for balance problems is `NEGATIVE_INTERMEDIATE_BALANCE`, not an overflow panic.

**Test:** The provided test is valid and would reproduce the panic.

### H1-2: `InvokeExternal`-only tx rejected with `NO_REPLAY_PROTECTION` — INFORMATIONAL

**Trace:** `assert_and_advance_phase` (actions.cairo:277–286) only increments `curr_phase` past INVOKE_PHASE for `InvokeExternal`. `_client_apply_actions` (privacy.cairo:712–730) only sets `has_replay_protection = true` for `WriteOnce` actions. `InvokeExternal` produces `ServerAction::Invoke`, which has no `WriteOnce`, so `has_replay_protection` stays false, and the assertion at privacy.cairo:302 fires.

**Assessment:** This is confirmed behavior, but the hunter correctly classifies it as informational — it is explicitly by design and documented in the comment "at least one client action provides replay protection (WriteOnce)." Not a bug, but the error message is suboptimal.

### H1-3: Duplicate `SetViewingKey` fails on `NON_ZERO_VALUE` — INFORMATIONAL

**Trace:** Both `SetViewingKey` actions pass `assert_and_advance_phase` (both at phase 0, `0 >= 0` holds both times; phase stays at 0 since it's not INVOKE_PHASE). On the second action, `_apply_write_once` finds the `public_key` storage slot already written and panics with `NON_ZERO_VALUE` (errors.cairo). The hunter is correct.

**Assessment:** Not a security issue. The WriteOnce guard catches it correctly; the error message
surface is poor but non-exploitable.

---

## Hunter 2 Detailed Analysis

### H2-1: `sender_private_key` in `compute_enc_recipient_addr_hash` — REJECTED (severity overblown)

**Trace confirmed:** The hash at hashes.cairo:85–95 is:
```
h(ENC_RECIPIENT_ADDR_TAG, sender_addr, sender_private_key, index, 0, salt)
```
All inputs except `sender_private_key` are public: `sender_addr` is the caller, `index` is sequential
and public, `salt` is stored on-chain in `EncOutgoingChannelInfo.salt`, and `recipient_addr` is an
existing registered address.

**Why severity is overblown:** The private key on StarkNet is a scalar from the Stark curve field,
which has order ~2^251. Even if an attacker knows `sender_addr`, `index`, `salt`, and
`recipient_addr` exactly, and can try `2^251` candidates — each requiring one Poseidon hash
evaluation — this is **computationally infeasible**. Poseidon is a collision-resistant hash
function; there is no shortcut to invert it. The attacker cannot "brute-force" a 251-bit key space
with any foreseeable hardware.

**However,** the hunter's concern is architecturally valid as a design principle: the outgoing
channel info encryption deviates from the ECDH pattern used everywhere else. Using the raw private
key as a symmetric key material — even in a Poseidon hash — is less robust than ECDH, and any
weakness in the private key generation (low entropy, biased RNG) would be more catastrophically
exploitable than under ECDH. The design is **suboptimal** but not a practical vulnerability given
a correctly generated private key.

**Verdict:** REJECTED as "High". Re-classified as Informational — design note worth tracking for
future key management hardening, but not an exploitable vulnerability.

### H2-2: Missing cross-function hash collision tests — INFORMATIONAL

**Confirmed:** The domain tags differ (`ENC_TOKEN_TAG:V1` vs `ENC_AMOUNT_TAG:V1`), which provides
correct domain separation. No exploitable collision exists. This is a test coverage gap only.

### H2-3: Undocumented zero placeholder in `compute_enc_token_hash` — INFORMATIONAL

**Confirmed:** The zero at position 3 of `compute_enc_token_hash` is undocumented, while the
analogous zero in `compute_note_id` and `compute_subchannel_id` has an explicit comment. No
exploit path exists; this is a documentation gap.

### H2-4: Storage key collisions between Maps — REJECTED (confirmed safe)

Hunter's own analysis is correct. StarkNet storage addressing namespaces each Map separately. No
issue.

### H2-5: `compute_outgoing_channel_id` as private-key brute-force oracle — REJECTED (severity overblown)

Same reasoning as H2-1. The `outgoing_channel_id` is `h(OUTGOING_CHANNEL_ID_TAG, sender_addr,
sender_private_key, index, 0)` — all inputs except `sender_private_key` are public. An attacker
could verify a guessed key with one hash, but the 251-bit key space makes exhaustive search
infeasible. The architectural concern (raw private key in hash) is the same as H2-1. Informational.

---

## Hunter 6 Detailed Analysis

### H6-1: Enc note leaves `token` slot zero — INFORMATIONAL

**Trace confirmed:** `create_enc_note` at privacy.cairo:618–622:
```cairo
// Only `packed_value` needs to be written to storage, `token` is initialized to zero.
array![
    to_write_once_action(:storage_address, value: packed_value),
    ...
]
```
Only `packed_value` is written; `token` stays at zero for enc notes. The `Note` struct at
objects.cairo:90–100 documents `token: zero for encrypted notes`. The hunter is correct that this is
an implicit invariant.

**Assessment:** The `_deposit_to_open_note` function at privacy.cairo:957 guards against misrouted
deposits with `assert(salt == OPEN_NOTE_SALT, errors::NOTE_NOT_OPEN)` before reading `token`. No
current exploit. Informational — a future code path that reads `token` without checking salt would
silently get zero.

### H6-2: `_prepare_note_creation` does not verify `sender_private_key` against registered public key — CONFIRMED / Medium

**Trace confirmed:** `open_channel` (privacy.cairo:365–369) performs:
```cairo
let sender_public_key = self.public_key.read(sender_addr);
assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
assert(
    sender_public_key == derive_public_key(private_key: sender_private_key),
    errors::SENDER_NOT_AUTHENTICATED,
);
```
`_prepare_note_creation` (privacy.cairo:671–707) performs **no such check**. It only verifies that
a subchannel exists for the computed `subchannel_marker`. 

**The consequence the hunter identifies is real:** A user can call `create_enc_note` or
`create_open_note` with any `sender_private_key` that has a valid subchannel, without that key
matching the one registered via `set_viewing_key`. Notes created this way are bound to a different
`channel_key` (derived from the unregistered `sender_private_key`), meaning the auditor — who only
knows the registered key from `enc_private_key` — cannot decrypt these notes. This breaks auditor
visibility.

**Exploitability:** Requires the sender to already control a valid subchannel opened with the
unregistered key. The exploit is self-inflicted (only the sender is affected) unless the auditor
compliance assumption is a security property of the system. If auditor coverage is a security
invariant, this is a medium-severity gap. The hunter's severity call is correct.

### H6-3: `create_open_note` silently discards `channel_key` — INFORMATIONAL

Confirmed. The `_` binding at privacy.cairo:640 silently discards `channel_key`. No functional bug
today; purely a code quality concern.

### H6-4: `create_open_note` has no salt — weaker privacy on retried transactions — INFORMATIONAL

**Trace confirmed:** `CreateOpenNoteInput` (actions.cairo:119–133) has no `salt` field. The
`OPEN_NOTE_PACKED_VALUE` is a constant (`pack(1, 0)`), so every attempt to create an open note at
the same `(channel_key, token, index)` produces identical on-chain state. The hunter is correct
that this allows correlation of retried transactions, unlike enc notes which use a fresh salt per
attempt.

**Impact:** Limited to the revert-and-retry window. WriteOnce prevents overwriting after success.
Low privacy impact in practice — this affects failed transaction correlation, not fund security.
Informational.

### H6-5: `index - 1` underflow guarded by short-circuit only — INFORMATIONAL

Confirmed. The guard `index.is_zero() || ...` is load-bearing for the unsigned `index - 1`
subtraction at privacy.cairo:691–699. Hunter 1's analysis confirmed this pattern is correct
(Cairo `||` is short-circuiting). The fragility concern is valid as a future maintenance risk;
not a current bug.

### H6-6: Zero-amount enc note consumes index permanently — INFORMATIONAL

**Trace confirmed:** `CreateEncNoteInput.assert_valid` explicitly allows `amount = 0`
(actions.cairo:108–109 comment). The resulting note has non-zero `packed_value` (the encrypted
amount equals the hash keystream, which is non-zero with overwhelming probability). The note
permanently occupies an index but is unusable (use_note asserts `amount.is_non_zero()`). This is
intentional design per the comment: "enable note creation on reverted transaction indexes."
No bug.

### H6-7: `open_subchannel` does not explicitly verify `recipient_public_key` against registry — INFORMATIONAL

**Trace confirmed:** `open_subchannel` at privacy.cairo:428–475 checks `channel_marker` (which
embeds `recipient_public_key`), and channels are only created via `open_channel` which does verify
the registry. So the transitive trust chain is sound for the current immutable-key design. The
hunter correctly notes this is latent fragility if key rotation were ever added. Informational.

---

## Hunter 7 Detailed Analysis

### H7-1 and H7-2: Self-invocation and re-entrancy — REJECTED (confirmed safe)

Both findings are self-confirmed non-issues by the hunter. The analysis is correct: self-invocation
fails with ENTRYPOINT_NOT_FOUND, and the re-entrancy guard (privacy.cairo:740, 746) covers the
entire `apply_actions` call. The mock_reentrancy test confirms this.

### H7-3: `_deposit_to_open_note` before `checked_sub` — INFORMATIONAL

**Trace confirmed:** At privacy.cairo:824–844, `_deposit_to_open_note` and ERC-20 transfers execute
before `checked_sub` panics if `open_note_deposits.len() > undeposited_open_notes`. Since Cairo
panics revert all state, this is safe. The hunter's reasoning about future partial-commit semantics
is a valid maintenance concern.

### H7-4: `undeposited_open_notes` is transaction-scoped — INFORMATIONAL

**Trace confirmed:** `undeposited_open_notes` is initialized to 0 at privacy.cairo:804 and only
incremented on `EmitOpenNoteCreated` within the same `apply_actions` call. Cross-transaction
deposits to pre-existing open notes are impossible by design. The error message
`TOO_MANY_OPEN_NOTES_DEPOSITED` is misleading for the case of a single deposit with no same-tx
open note creation. Design constraint, not a bug.

### H7-5: Multiple `Invoke` actions unrestricted at server layer — INFORMATIONAL

**Trace confirmed:** At the client layer, `assert_and_advance_phase` enforces at most one
`InvokeExternal` per tx (sets `curr_phase = 8`, blocking a second). At the server layer
(`apply_actions`), the raw `Span<ServerAction>` is not restricted — but `validate_proof` binds
the action list to the L1 message hash, so an attacker cannot submit an arbitrary multi-Invoke
list. Defense-in-depth recommendation is reasonable but not a current vulnerability.

### H7-6: `InvokeExternalInput` calldata unchecked in length — INFORMATIONAL

**Confirmed:** `InvokeExternalInputValid::assert_valid` ignores `calldata` (actions.cairo:216).
StarkNet charges gas for calldata, so no gas-griefing at contract level. L1 message size
constraints could be a concern depending on infrastructure. Informational.

---

## Hunter 11 Detailed Analysis

### H11-1: Residual `in_token` approval after deposit never cleared — CONFIRMED / Low

**Trace confirmed:** In `vesu_lending_anonymizer.cairo:152–155` (Deposit branch):
```cairo
in_erc20.approve(spender: out_token, amount: assets);
IVTokenDispatcher { contract_address: out_token }
    .deposit(:assets, receiver: self_addr)
```
If the vault pulls less than `assets` (due to fees, rounding, or non-standard implementation), a
residual allowance from `in_token` to `out_token` remains. There is no post-deposit `approve(0)`
reset.

**Impact:** Requires a malicious or non-standard vault to pull less than approved. For any vault
in the approved set that behaves exactly as ERC-4626 requires (consuming exactly `assets`), no
residual exists. The risk is real if vaults can have deposit fees. Low severity is appropriate.

### H11-2: Stranded `in_token` balance when `assets < anonymizer_balance` — SUSPECTED / Medium

**Trace confirmed:** The `assets` parameter in the calldata of `InvokeInput` is entirely
user-controlled at the proof-generation layer. The privacy contract's token balance tracking
(via `subtract_balance` and the `assert_valid` at end of `main`) only enforces that `Withdraw`
amounts match `UseNote`/`Deposit` credits — it does not enforce that the anonymizer consumes the
full transferred amount.

**The actual risk:** The anonymizer code uses caller-supplied `assets` directly, not the anonymizer's
actual `in_token` balance. If `assets < anonymizer_balance`, the surplus `in_token` stays in the
anonymizer with no recovery mechanism (no sweep, no admin, no storage).

**Why SUSPECTED rather than CONFIRMED:** In the intended protocol, the off-chain proof/server
infrastructure always sets `assets == amount` withdrawn to the anonymizer. The hunter correctly
notes there is no **on-chain** enforcement of this invariant. The severity depends on whether the
proof system can be configured to produce a mismatch. Since the action list is proof-bound, a
correctly operating prover would not produce this. The finding is real as a defense-in-depth gap
and would be exploitable if the off-chain system is compromised. Medium is appropriate.

---

## Hunter 12 Detailed Analysis

### H12-1: Core withdraw flow is correct — REJECTED (confirmed safe)

Hunter's own analysis is thorough and correct. The withdraw flow (burn shares → receive underlying
→ approve privacy contract → return deposit) is sound under ERC-4626 semantics.

### H12-2: `assets > u128::MAX` causes `RECEIVED_AMOUNT_OVERFLOW` — INFORMATIONAL

**Trace confirmed:** The vault's own share-balance check would revert first if the anonymizer
doesn't hold enough shares. The `RECEIVED_AMOUNT_OVERFLOW` path is unreachable in practice. Adding
a defensive `assert(assets.high == 0, ...)` before the vault call would make the invariant
explicit. Informational.

### H12-3: No caller authentication on `privacy_invoke` — CONFIRMED / Low

**Trace confirmed:** `vesu_lending_anonymizer.cairo:141`:
```cairo
let privacy_addr = get_caller_address();
```
Any external caller becomes `privacy_addr` and receives the `approve` allowance. If the anonymizer
holds vToken balance between protocol calls (e.g., from a prior failed tx that left shares stranded
— see H14-1), an attacker could:
1. Call `privacy_invoke(Withdraw, vToken, underlying, shares, arbitrary_note_id)`.
2. The anonymizer burns the stranded shares and approves the attacker for the underlying.
3. The attacker calls `transfer_from(anonymizer, attacker, underlying_amount)`.

The attack requires stranded vToken balance to exist, which is exactly what H14-1 shows can happen
in normal operation. The two findings compound each other. Low is appropriate in isolation, but the
combination of H14-1 + H12-3 creates a plausible fund-loss path.

---

## Hunter 14 Detailed Analysis

### H14-1: Vesu Withdraw strands excess vTokens in anonymizer — CONFIRMED / Medium

**Trace confirmed:** The Withdraw flow at vesu_lending_anonymizer.cairo:157–161:
```cairo
IVTokenDispatcher { contract_address: in_token }
    .withdraw(:assets, receiver: self_addr, owner: self_addr)
```
ERC-4626 `withdraw(assets, ...)` burns the minimum shares needed to deliver exactly `assets`
underlying. If the user sent `shares` of vToken to the anonymizer, and the exchange rate has
changed such that `shares > previewWithdraw(assets)`, then `shares - burned_shares` remain in the
anonymizer after the call.

**Impact:** There is no `sweep`, `rescue`, or any function in the anonymizer that could recover
these surplus vTokens. The anonymizer has empty storage and no owner role. The stranded tokens
represent real economic loss for the user, and — combined with the lack of caller authentication
(H12-3) — can be drained by an attacker.

**The hunter's scenario is realistic:** Share prices in Vesu lending vaults accrete interest
continuously. The gap between proof generation time and execution time (which can be multiple
blocks in a congested network) can cause the share price to increase, leaving surplus shares.

**Severity: Medium confirmed.** This is a real fund-loss vector with no recovery path.

### H14-2: `note_id` is user-controlled — INFORMATIONAL

Confirmed as safe by construction. The privacy contract's checks (`NOTE_NOT_FOUND`, `NOTE_NOT_OPEN`,
`TOKEN_MISMATCH`) cover all invalid `note_id` values. A user directing to the wrong `note_id`
harms only themselves.

### H14-3: `undeposited_open_notes` counter semantics — REJECTED (confirmed safe)

This is a duplicate observation of H7-4 and the hunter themselves confirm it as non-exploitable.
The accounting logic is sound.

### H14-4: Neither anonymizer validates caller is privacy contract — CONFIRMED (duplicate of H12-3)

Identical finding to H12-3. Confirmed. The additional detail about Ekubo applies as well: the
Ekubo swap anonymizer has no persistent input token balance (tokens arrive via `TransferTo` in the
same tx), so the attack surface there is limited to same-transaction frontrunning, which is harder
to exploit. Still, both anonymizers lack caller authentication.

### H14-5: Ekubo `clear_minimum` return value ignored — REJECTED (confirmed safe)

The comment in the code and the hunter's analysis correctly explain the design: the balance delta
captures the actual output, and slippage is enforced by `minimum_received` passed to
`clear_minimum`. No bug.

---

## Cross-Cutting Observations

### Critical compound risk: H14-1 + H12-3 (vToken stranding + unauthorized `privacy_invoke`)

These two findings interact to form a fund-loss path that neither hunter fully connected:

1. A legitimate Vesu withdraw leaves surplus vTokens in the anonymizer (H14-1) due to exchange rate
   accrual between proof generation and execution.
2. The surplus vTokens sit in the anonymizer with no expiry.
3. Any address can call `privacy_invoke(Withdraw, vToken, underlying, surplus_amount, arbitrary)`.
4. The anonymizer burns the surplus shares and approves the **attacker** for the underlying.
5. The attacker calls `transfer_from(anonymizer, attacker, underlying)` and drains the funds.

This is a **realistic, atomic, high-confidence exploit path** against the Vesu anonymizer,
contingent on step 1 producing surplus shares — which the ERC-4626 exchange-rate argument shows is
expected in normal operation when share prices increase. The combined severity is **High**, even
though each individual finding is Medium/Low.

**Recommended fix (both issues):** In `privacy_invoke`, after the vault operation, transfer any
remaining `in_token` balance back to `privacy_addr` (the caller), or add a caller whitelist. The
simplest correct fix is to return remaining `in_token` to the caller at the end of `privacy_invoke`:
```cairo
let remaining_in = in_erc20.balance_of(account: self_addr);
if remaining_in.is_non_zero() {
    checked_transfer(token_address: in_token, recipient: privacy_addr, amount: remaining_in);
}
```
This prevents stranding (H14-1) and eliminates the attack surface for H12-3, since no balance
persists between calls.

### `_prepare_note_creation` audit visibility gap (H6-2)

If auditor coverage is a mandatory security property of this protocol (compliance use case), the
missing `sender_private_key` authentication check in `_prepare_note_creation` is a significant gap.
Notes created with an unregistered key are invisible to the auditor. The fix is straightforward:
add the same two assertions present in `open_channel` to `_prepare_note_creation`.
