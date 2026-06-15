# Bug Hunter 6 — Findings

Focus: `create_enc_note`, `create_open_note`, and `_prepare_note_creation` in `src/privacy.cairo`

---

## Finding 1: `create_enc_note` Leaves the Note `token` Slot Unwritten — Stale Zero Can Confuse Subsequent Logic

**Severity: Low / Informational**

**Location:** `privacy.cairo` line 618–622; `objects.cairo` lines 89–100

**Description:**

The `Note` struct is a two-field struct stored over two sequential storage slots:
- Slot 0: `packed_value` (felt252)
- Slot 1: `token` (ContractAddress)

`create_enc_note` deliberately writes only `packed_value` to storage, relying on the comment "token is initialized to zero" (line 618). The open-note path writes both fields via `to_write_once_action(..., value: note)` where `note` is a full `Note` struct (two felts).

This asymmetry means an encrypted note at `note_id` X leaves slot 1 at zero (no explicit write), while an open note at the same position writes the actual token address into slot 1.

**Concrete issue — `_deposit_to_open_note` reads both fields:**

```cairo
let Note { packed_value, token: note_token } = note_entry.read();
...
assert(token == note_token, errors::TOKEN_MISMATCH);
```

If an enc note were somehow misrouted here, `note_token` would read as `ContractAddress::zero()`. The check `salt == OPEN_NOTE_SALT` (line 957) does prevent deposit into an enc note, so today this causes no direct exploit.

**Latent risk — upgrade / new code path:**

If a future code path reads `Note.token` on an enc note without first checking the salt, it will silently get zero and may skip the TOKEN_MISMATCH check or confuse the token accounting. The field is documented as "zero for encrypted notes" but this relies on default zero-initialisation of storage, which is an implicit contract that future reviewers can miss.

**Recommendation:** Document explicitly in the `Note` struct that `token == zero` is a valid and expected state for enc notes. Alternatively, write the actual `token` address in the enc-note path too; the WriteOnce check on slot 0 already prevents overwriting, so the write to slot 1 would either be the first write (safe) or would conflict and revert (still safe).

---

## Finding 2: `_prepare_note_creation` Does Not Verify Sender's Private Key Against Registered Public Key

**Severity: Medium**

**Location:** `privacy.cairo` lines 671–707 (compare with `open_channel` lines 365–369)

**Description:**

`open_channel` contains an explicit authentication check:
```cairo
let sender_public_key = self.public_key.read(sender_addr);
assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
assert(
    sender_public_key == derive_public_key(private_key: sender_private_key),
    errors::SENDER_NOT_AUTHENTICATED,
);
```

`_prepare_note_creation` (called by both `create_enc_note` and `create_open_note`) performs no such check. It computes a `channel_key` from the caller-supplied `sender_private_key` and validates only that a subchannel exists for the resulting `subchannel_marker`. There is no assertion that `sender_private_key` corresponds to the `sender_addr`'s on-chain registered public key.

**Attack scenario:**

Alice (`sender_addr = A`) has a registered public key `PK_A = derive_public_key(k_A)`.
Alice has a legitimately opened channel (using `k_A`) with subchannel for token `T` to Bob.

Suppose Alice also controls a second key pair `(k_B, PK_B)` for which she has opened a separate channel with the same recipient Bob and the same token `T` — this creates a second subchannel_marker.

When Alice calls `create_enc_note` with `sender_private_key = k_B`, the contract:
1. Computes `channel_key_B = h(CHANNEL_KEY_TAG, A, k_B, Bob, PK_Bob)`
2. Computes `subchannel_marker_B` — which exists (Alice opened that subchannel)
3. Proceeds to create the note under `channel_key_B`

This is arguably fine — Alice chose to use a different key. But the contract never verifies that `k_B` is Alice's registered key. In other words, the note-creation path does not enforce a 1:1 binding between `sender_addr` and `sender_private_key`. An address can create notes using any private key that has a valid subchannel, without that key being the one registered via `set_viewing_key`.

**Practical consequence today:** An attacker who does NOT own address A cannot exploit this because:
- `__execute__` is gated by `assert_valid_signature(user_addr, tx_info)`, which requires a valid ECDSA signature over the transaction hash with address A's account key.
- The tx-level signature is Alice's account key (separate from the privacy key).

So the exploitability is limited to Alice herself — she can voluntarily create notes using any of her own private keys. However:

1. The auditor's decryption assumes each user has exactly one privacy key (from `set_viewing_key`). Notes created under a different `k_B` are not decryptable by the auditor (they are bound to `channel_key_B`, whose key was never submitted to the auditor via `enc_private_key`). This **breaks auditor visibility** for any notes created with an unregistered key.

2. Notes created with an unregistered `k_B` are **off-audit-record** — the auditor encrypted key (`enc_private_key`) was registered for `k_A`, not `k_B`. The auditor cannot reconstruct the channel_key for those notes.

**Root cause:** `_prepare_note_creation` relies on the subchannel_marker as the sole authorization proof, without checking that `sender_private_key` matches the sender's registered viewing key.

**Recommendation:** Add the same authentication check as `open_channel`:
```cairo
let sender_public_key = self.public_key.read(sender_addr);
assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
assert(
    sender_public_key == derive_public_key(private_key: sender_private_key),
    errors::SENDER_NOT_AUTHENTICATED,
);
```

---

## Finding 3: `create_open_note` Discards the `channel_key` Return Value — Auditor Encryption Uses Unauthenticated `recipient_addr`

**Severity: Low / Informational**

**Location:** `privacy.cairo` lines 640–665

**Description:**

`_prepare_note_creation` returns a triple `(channel_key, storage_address, note_id)`. In `create_enc_note`, the `channel_key` is used to compute the encrypted amount via `enc_note_packed_value`. In `create_open_note`, the return is:

```cairo
let (_, storage_address, note_id) = self._prepare_note_creation(...);
```

The `channel_key` is discarded (named `_`). The open note's auditor-facing encryption is:

```cairo
let enc_recipient_addr = encrypt_user_addr(
    ephemeral_secret: random,
    auditor_public_key: self.auditor_public_key.read(),
    user_addr: recipient_addr,
);
```

This is correct: the function encrypts `recipient_addr` for the auditor using ECDH. The `channel_key` is not needed here because open notes do not encrypt their amount — the amount is set at deposit time in plaintext.

**No bug in behaviour**, but the silent discard of `channel_key` is a code smell. If a future developer adds logic after the `_prepare_note_creation` call and needs `channel_key`, they may not realise it was discarded. The `_` binding gives no compile-time warning in Cairo.

**Recommendation:** Name the discarded value with a comment: `let (_channel_key, storage_address, note_id) = ...;` and add a comment explaining why `channel_key` is not needed for open notes.

---

## Finding 4: `create_open_note` Does Not Include a `salt` Input — Re-use After Revert Leaks Index Correlation

**Severity: Low**

**Location:** `privacy.cairo` lines 628–666; `actions.cairo` lines 119–145

**Description:**

`CreateEncNoteInput` includes a `salt` field (lines 95–101 of `actions.cairo`) specifically to "guarantee one-time key usage, preventing privacy-related data leakage if a transaction is reverted and the same note id is reused." The salt ensures the encrypted amount ciphertext is fresh on each attempt.

`CreateOpenNoteInput` has a `random` field but no analogous `salt`. The `random` is used only for auditor encryption of the recipient address (`encrypt_user_addr`). The open note's on-chain state is `Note { packed_value: OPEN_NOTE_PACKED_VALUE, token }` — the same value regardless of how many times the transaction is attempted at the same index.

Because the open note's `packed_value` is a deterministic constant (`OPEN_NOTE_PACKED_VALUE = pack(1, 0)`), an observer who sees multiple failed attempts at the same `(channel_key, token, index)` learns that the sender retried the same open note. This is weaker than the enc-note privacy guarantee.

**Practical privacy impact:** An attacker watching the L2 mempool or failed transactions can correlate retried open-note creations at the same index, linking the sender's address and token choice across attempts. For enc notes, the salt prevents this correlation even for same-index retries (the emitted `packed_value` differs).

**Note:** The WriteOnce check prevents re-creation after a successful write. This issue only applies to the window between a failed/reverted attempt and a retry.

**Recommendation:** Document this weaker privacy guarantee in the open note spec/comments, or add a `salt` field to `CreateOpenNoteInput` and incorporate it into the emitted event (even if not stored on-chain), so that observers cannot correlate retried attempts.

---

## Finding 5: Sequential Index Check Uses Unsigned Arithmetic — `index = 0` Edge Case Is Handled But Fragile

**Severity: Informational**

**Location:** `privacy.cairo` lines 691–700

**Description:**

```cairo
assert(
    index.is_zero()
        || self
            .notes
            .entry(compute_note_id(:channel_key, :token, index: index - 1))
            .packed_value
            .read()
            .is_non_zero(),
    errors::INDEX_NOT_SEQUENTIAL,
);
```

`index` has type `usize`. The `index - 1` is unsigned subtraction. If `index == 0` and the short-circuit `index.is_zero()` did not exist, this would underflow (panic or wrap, depending on the arithmetic mode). The short-circuit correctly prevents this.

However, Cairo's `usize` subtraction panics on underflow rather than wrapping silently. The existing guard `index.is_zero()` is the only protection. If the guard were ever refactored (e.g., merged into a single expression or inverted), this would become a panic vector.

**Recommendation:** Use `index.checked_sub(1)` with an `Option` match, or add a comment explaining why the `||` short-circuit is load-bearing:

```cairo
// IMPORTANT: `index.is_zero()` must be checked first; `index - 1` panics on underflow.
assert(
    index.is_zero()
        || self.notes.entry(compute_note_id(:channel_key, :token, index: index - 1))
               .packed_value.read().is_non_zero(),
    errors::INDEX_NOT_SEQUENTIAL,
);
```

---

## Finding 6: `create_enc_note` with `amount = 0` Produces an Unusable Note But Consumes an Index

**Severity: Low**

**Location:** `privacy.cairo` lines 596–623; `actions.cairo` lines 104–117

**Description:**

`CreateEncNoteInput.assert_valid` explicitly allows `amount = 0`:
```cairo
// Zero `amount` is allowed to enable note creation on reverted transaction indexes,
// preventing data leakage from index reuse after a revert.
```

When `amount = 0`, `subtract_balance(token, 0)` is called, which inserts a zero entry into the token balance dict. The final `token_balances.squash().assert_valid()` then requires this token's balance to be zero — which it is (0 == 0). So a standalone zero-amount enc note transaction with no deposit is accepted and processes without error.

The resulting note has a valid non-zero `packed_value` (because `enc_amount = hash.low + 0 = hash.low`, and the hash is non-zero with overwhelming probability), but `use_note` will always fail for it:

```cairo
let amount = decode_note_amount(:packed_value, :channel_key, :token, :index);
assert(amount.is_non_zero(), errors::ZERO_NOTE_AMOUNT_USAGE);
```

**Issue:** The zero-amount note permanently occupies an index in the sequential chain. Any subsequent note must be at `index + 1`, and the zero-amount note at `index` satisfies the sequential check (its packed_value is non-zero). This is the intended behaviour.

However, there is a subtle issue: if `enc_amount = hash.low wrapping_add 0 = hash.low` happens to equal zero — i.e., `h(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt).low == 0` — then `packed_value = pack(salt, 0)`. Since `salt >= 2`, `packed_value = u256 { high: salt, low: 0 }` which is non-zero as a u256, and its `try_into().unwrap()` as felt252 succeeds (since `salt < TWO_POW_120 < P`). So `packed_value != 0` holds. The `assert(packed_value.is_non_zero(), ZERO_NOTE_VALUE)` at line 614 would not fire.

But when `use_note` later decrypts: `decrypt_note_amount(enc_amount=0, salt, ...) = 0 - hash.low` which wraps around (wrapping_sub), giving a very large u128 value — nonzero. So a note with `amount=0` actually stores an enc_amount equal to `hash.low`, and decryption recovers `hash.low wrapping_sub hash.low = 0`. This is correct and consistent.

**No logic bug here**, but the interaction between zero-amount notes and index sequencing is an invariant that should be explicitly tested.

---

## Finding 7: `open_subchannel` Does Not Verify `recipient_public_key` Against On-Chain Registry

**Severity: Medium**

**Location:** `privacy.cairo` lines 428–475

**Description:**

While slightly outside the assigned scope, this finding is directly relevant to how `_prepare_note_creation` inherits trust from `open_subchannel`.

In `open_channel`, the recipient's public key is fetched from chain:
```cairo
let recipient_public_key = self.public_key.read(recipient_addr);
assert(recipient_public_key.is_non_zero(), errors::RECIPIENT_NOT_REGISTERED);
```

In `open_subchannel`, the `recipient_public_key` is **caller-supplied** in the input:
```cairo
let OpenSubchannelInput { recipient_addr, recipient_public_key, channel_key, index, token, salt } = input;
let channel_marker = compute_channel_marker(:channel_key, :sender_addr, :recipient_addr, :recipient_public_key);
assert(self.channel_exists.read(channel_marker), errors::INVALID_CHANNEL);
```

The channel_marker check validates that `(channel_key, sender_addr, recipient_addr, recipient_public_key)` are consistent with a previously opened channel. Since channels are opened only through `open_channel` — which did verify `recipient_public_key` — the channel_marker check indirectly validates the key.

**However:** there is no explicit check that `recipient_public_key == self.public_key.read(recipient_addr)`. If the recipient later changes or rotates their key (e.g., via a future mechanism), a stale `recipient_public_key` could still pass the channel_marker check. For the current contract (viewing key is immutable once set via WriteOnce), this is not an issue. But it is a latent fragility.

**Recommendation:** Add an explicit assertion in `open_subchannel` (and thus transitively in `_prepare_note_creation`):
```cairo
let expected_public_key = self.public_key.read(recipient_addr);
assert(recipient_public_key == expected_public_key, errors::INVALID_PUBLIC_KEY);
```

This makes the invariant explicit rather than relying on the transitivity through channel_marker.

---

## Summary Table

| # | Title | Severity | Lines |
|---|-------|----------|-------|
| 1 | Enc note leaves `token` slot zero — implicit contract on storage layout | Low / Info | privacy.cairo 618–622 |
| 2 | `_prepare_note_creation` does not verify `sender_private_key` matches registered public key — breaks auditor visibility | **Medium** | privacy.cairo 671–707 |
| 3 | `create_open_note` silently discards `channel_key` — code smell | Info | privacy.cairo 640–665 |
| 4 | `create_open_note` has no salt — weaker privacy on retried transactions | Low | privacy.cairo 628–666 |
| 5 | `index - 1` underflow guarded by short-circuit only — fragile | Info | privacy.cairo 691–700 |
| 6 | Zero-amount enc note consumes index permanently | Low / Info | privacy.cairo 596–623 |
| 7 | `open_subchannel` does not explicitly verify `recipient_public_key` against registry | Medium | privacy.cairo 428–475 |
