# Bug Hunter 16 — Findings Report

## Scope

Files analyzed:
- `/home/user/starknet-privacy/packages/privacy/src/privacy.cairo` (lines 709–906: `validate_proof`, `collect_fee`, `_apply_actions`, `_apply_write_once`, `_client_apply_actions`)
- `/home/user/starknet-privacy/packages/privacy/src/utils.cairo` (lines 396–411: `to_write_once_action`, `open_note`)
- `/home/user/starknet-privacy/packages/privacy/src/objects.cairo`
- `/home/user/starknet-privacy/packages/privacy/src/errors.cairo`

---

## Finding 1 (Medium): `create_open_note` WriteOnce token slot zero-write is silently skipped, corrupting the Note

**File**: `packages/privacy/src/privacy.cairo:661`, `packages/privacy/src/utils.cairo:400–406`, `packages/privacy/src/privacy.cairo:891–906`

### Description

`create_open_note` stores a full `Note { packed_value, token }` struct via `to_write_once_action`. This serializes into two felt252 slots: `[packed_value, token]`. The `_apply_write_once` loop then writes both slots, but it only checks that `value[0]` (the first element) is non-zero. It does **not** check that subsequent elements are non-zero before writing them.

For each slot in sequence, the loop:
1. Checks the storage location is currently zero.
2. Writes the value.

If the token address serializes to zero (which cannot happen in practice for a valid ERC20 address, since zero is rejected by `CreateOpenNoteInput::assert_valid`), slot 1 would be written as zero. More importantly, **the zero-check on slot 1 passes** because fresh storage is zero, so a zero value would be written without error, silently corrupting the `Note.token` field.

However, the more material concern exists: the WriteOnce check only prevents *re-writing*, it does not prevent writing a zero value that leaves a slot indistinguishable from "never written". Storage in StarkNet defaults to zero; writing zero is a no-op at the storage layer. If any slot in the serialized value is zero:
- The check `storage_read_syscall(...).is_zero()` passes (correct for first write).
- `storage_write_syscall(..., value: 0)` is a no-op.
- That slot remains zero permanently.
- On re-submission, the zero-check on that same slot still passes (`is_zero()` is true), so the WriteOnce protection **does not fire** for that slot.

This means a WriteOnce action with a zero interior slot is **not idempotent-protected for that slot**: a second call could overwrite a different (non-zero) slot before or after the zero slot, partially re-writing the multi-slot value without triggering `NON_ZERO_VALUE`.

### Concrete attack scenario for `open_channel`

`open_channel` calls `to_write_once_action` on `EncOutgoingChannelInfo { salt, enc_recipient_addr }`. The `enc_recipient_addr` is computed as:

```cairo
enc_recipient_addr = h(ENC_RECIPIENT_ADDR_TAG, sender_addr, sender_private_key, index, 0, salt) + recipient_addr
```

This is field addition modulo the StarkNet field prime P. If `h(...) + recipient_addr ≡ 0 (mod P)`, then `enc_recipient_addr` would serialize to zero in slot 1.

In that case:
- Slot 0 (`salt`, non-zero) is checked and written — WriteOnce protection applies.
- Slot 1 (`enc_recipient_addr = 0`) is "written" but storage does not change (zero write is no-op).
- A subsequent `open_channel` for the same `outgoing_channel_id` would fail on slot 0 (salt is non-zero → `NON_ZERO_VALUE`), so this does not allow replay.

The channel data is corrupted: `outgoing_channel_info.enc_recipient_addr = 0`. The sender cannot later look up or decrypt the outgoing channel info to get the recipient address, causing a data integrity loss for that channel. The probability is ~1/P ≈ 2^{-251}, making this a low-probability event for `EncOutgoingChannelInfo`.

### Concrete scenario for `create_open_note`

For `create_open_note`, the full `Note { packed_value: OPEN_NOTE_PACKED_VALUE, token }` is serialized. `OPEN_NOTE_PACKED_VALUE = 2^128` (non-zero). The `token` is a `ContractAddress`; zero is checked in `assert_valid`. However, if a future change removed that check or a bug produced a zero token, the WriteOnce guarantee on the token slot would silently pass.

### Root cause

`_apply_write_once` checks only `value[0].is_non_zero()` at the start. It does not validate that all elements in `value` are non-zero before beginning the write loop. The protection against "partial writes" (slot N fails, slot M already written) is handled by Starknet's atomic transaction revert. But the protection against "zero value bypasses idempotency" is only enforced for slot 0 via the pre-loop assert.

```cairo
fn _apply_write_once(ref self: ContractState, input: WriteOnceInput) {
    let WriteOnceInput { storage_address, value } = input;
    assert(!value.is_empty(), internal_errors::UNEXPECTED_EMPTY_VALUE);
    assert(value[0].is_non_zero(), internal_errors::UNEXPECTED_ZERO_VALUE);  // Only slot 0 checked
    // ...
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

### Impact

If any serialized slot beyond slot 0 is zero:
- The stored data is silently corrupted (zero instead of the intended value).
- The WriteOnce replay protection is **bypassed for that slot**: a second call can overwrite neighboring non-zero slots without triggering `NON_ZERO_VALUE` for the zero slot.

**Severity**: Low-to-Medium. The zero probability is astronomically small for the ECDH-derived fields (1/P ≈ 2^{-251}). However, the structural assumption that "WriteOnce protects all slots" is violated for any multi-slot type with a zero interior element. The fix is straightforward.

### Recommended fix

Assert all serialized values are non-zero before the write loop, or assert each element individually as it is processed:

```cairo
fn _apply_write_once(ref self: ContractState, input: WriteOnceInput) {
    let WriteOnceInput { storage_address, value } = input;
    assert(!value.is_empty(), internal_errors::UNEXPECTED_EMPTY_VALUE);
    // Validate all elements are non-zero before any write
    for felt in value {
        assert(felt.is_non_zero(), internal_errors::UNEXPECTED_ZERO_VALUE);
    }
    // ... then write loop
}
```

---

## Finding 2 (Informational): `_apply_write_once` interleaved check-then-write cannot produce partial state

**File**: `packages/privacy/src/privacy.cairo:891–906`

### Description

For a multi-slot WriteOnce (e.g. `EncOutgoingChannelInfo` with 2 slots), the loop interleaves reads and writes:

```
slot 0: check is_zero → write V0
slot 1: check is_zero → write V1
```

If slot 1's check fails (already non-zero) and panics, slot 0 has already been written. This was a concern for partial state corruption.

**This is NOT a bug.** On StarkNet, all state changes within a transaction that panics are atomically reverted. The panic on slot 1's `NON_ZERO_VALUE` assertion rolls back the slot 0 write. No partial state is possible.

### Status

Confirmed safe. No action required.

---

## Finding 3 (Informational): `create_enc_note` correctly writes only `packed_value` (single slot)

**File**: `packages/privacy/src/privacy.cairo:618–622`

### Description

`create_enc_note` uses `to_write_once_action(:storage_address, value: packed_value)` where `packed_value` is a `felt252`. This writes only one slot (the `packed_value` field of the `Note` struct). The `Note.token` field is left at its storage default of zero.

The comment reads: "Only `packed_value` needs to be written to storage, `token` is initialized to zero."

For encrypted notes, the token address is zero in storage — it is not needed because the token is encoded in the subchannel. When the note is later used (via `UseNote`), the note is read and `token` comes from the `UseNoteInput`, not storage.

**This is by design and not a bug.** The WriteOnce protection covers only the single `packed_value` slot. Since `token` remains zero, a second call for the same note would correctly pass the zero-check for the token slot and fail on the packed_value slot (non-zero), triggering `NON_ZERO_VALUE`.

However, this means `Note.token` for encrypted notes is always zero on-chain, which is load-bearing for the "WriteOnce covers slot 0" invariant used by the `_apply_write_once` pre-check. If an encrypted note's `packed_value` somehow serialized to zero, the UNEXPECTED_ZERO_VALUE assert would catch it (and there is a redundant check `assert(packed_value.is_non_zero(), internal_errors::ZERO_NOTE_VALUE)` before calling `to_write_once_action`).

### Status

Confirmed safe. No action required.

---

## Finding 4 (Informational): `validate_proof` base block recency check is one-sided

**File**: `packages/privacy/src/privacy.cairo:776–781`

### Description

```cairo
assert(base_block_number < current_block_number, errors::INVALID_BASE_BLOCK_NUMBER);
assert(
    current_block_number <= base_block_number + self.proof_validity_blocks.read(),
    errors::PROOF_EXPIRED,
);
```

The check `base_block_number < current_block_number` ensures the proof is not from the future or the current block. The `PROOF_EXPIRED` check ensures the proof is not too old.

The lower bound is strict (`<`), meaning a proof submitted in the same block as its base block is rejected. This is correct: the proof covers state at block `base_block_number`, so it must be submitted after that block is finalized.

**This is correct and by design.** No bug.

---

## Finding 5 (Informational): `collect_fee` pulls from `get_caller_address()` — no pre-approval check

**File**: `packages/privacy/src/privacy.cairo:789–800`

### Description

```cairo
fn collect_fee(ref self: ContractState) {
    let fee_amount = self.fee_amount.read();
    if fee_amount.is_non_zero() {
        let fee_collector = self.fee_collector.read();
        checked_transfer_from(
            token_address: STRK_TOKEN_ADDRESS,
            sender: get_caller_address(),
            recipient: fee_collector,
            amount: fee_amount.into(),
        );
    }
}
```

The fee is pulled from the server (caller). If the server has not approved the privacy contract to spend STRK, the `checked_transfer_from` will revert. This is the intended design: the server is responsible for approving the fee before calling `apply_actions`.

There is no vulnerability here. The server controls when to approve and how much. If the server misconfigures the allowance, the transaction fails, which is the correct safe-failure mode.

**This is correct and by design.** No action required.

---

## Summary

| # | Severity | Finding |
|---|----------|---------|
| 1 | Low-Medium | `_apply_write_once` only validates slot 0 is non-zero; interior zero slots bypass WriteOnce idempotency protection and silently corrupt stored data |
| 2 | Informational | Interleaved check-then-write in `_apply_write_once` does not produce partial state due to atomic revert |
| 3 | Informational | `create_enc_note` single-slot write is intentional and correctly protected |
| 4 | Informational | `validate_proof` recency checks are correct |
| 5 | Informational | `collect_fee` caller-pull pattern is correct by design |

The only actionable finding is **Finding 1**: the WriteOnce guarantee is structurally weaker than intended for multi-slot types when any interior slot serializes to zero. While the probability of a field collision producing a zero intermediate value is negligible (1/P), the missing assertion is a correctness gap that should be closed.
