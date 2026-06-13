# Hunter 8 Findings — WriteOnce Mechanism & Storage Layout

**Scope:** `packages/privacy/src/privacy.cairo` (`_apply_write_once`), `packages/privacy/src/objects.cairo` (`to_write_once_action`, `WriteOnceInput`), `packages/privacy/src/utils.cairo` (`storage_path_to_felt252`), `packages/privacy/src/tests/test_objects.cairo`.

---

## Finding 1: `Note` Serde/Store Layout Alignment — CORRECT

**Claim:** Could `to_write_once_action(value: note)` and `starknet::Store` disagree on slot ordering for `Note { packed_value, token }`?

**Verdict: Not a bug.**

Both `Serde` and `starknet::Store` serialize `Note` in declaration order: `packed_value` at offset 0, `token` at offset 1. The tests `test_note_to_write_once_action` and `note_serialization_format` explicitly verify this equivalence with round-trip checks.

For encrypted notes, only `packed_value` (offset 0) is written; the `token` slot (offset 1) defaults to zero and is never read from storage by `use_note` (which takes `token` from `UseNoteInput`). For open notes, both slots are written. The design is intentional and documented.

---

## Finding 2: `EncPrivateKey` Serde/Store Layout Alignment — CORRECT

**Claim:** Could Serde and Store ordering for `EncPrivateKey { auditor_public_key, ephemeral_pubkey, enc_private_key }` diverge?

**Verdict: Not a bug.**

Both serialize in declaration order (slots 0, 1, 2). The tests `enc_private_key_serialization_format` and `test_enc_private_key_to_write_once_action` directly verify the equivalence.

---

## Finding 3: `storage_path_to_felt252` Base Address — CORRECT

**Claim:** Does `storage_path_to_felt252(path: self.notes.entry(note_id))` return the correct base address for the `Note` struct (i.e., the slot of `packed_value` at offset 0)?

**Verdict: Not a bug.**

The function returns the `__storage_pointer_address__` of the path's pointer, which for `Map<K, Note>` is the Pedersen-based address of the map entry — equivalent to `map_entry_address(selector!("notes"), [note_id])`. The `_apply_write_once` loop then writes to `base + offset` for each serialized felt. The test `test_apply_write_once_open_note` confirms round-trip correctness via `get_note()`.

---

## Finding 4 (REAL BUG — MEDIUM): Offset Overflow in `_apply_write_once` for Long Value Spans

**File:** `packages/privacy/src/privacy.cairo`, `_apply_write_once`

**Description:**

```cairo
let mut offset = 0;
for felt in value {
    let address = storage_address_from_base_and_offset(:base, :offset);
    // ...
    offset += 1;
}
```

`storage_address_from_base_and_offset` takes `offset: u8`. The local `offset` is inferred as `u8`. If `value.len() > 255`, writing the 256th felt causes `offset` to overflow `u8` — in debug mode this panics; in release mode it wraps and corrupts storage (writing felt 256 to the same address as felt 0, felt 257 to offset 1, etc.).

**Attack surface:** `WriteOnceInput.value` is a `Span<felt252>` that travels as a `ServerAction::WriteOnce` over the wire. In the normal flow the server actions come from `compile_and_panic` (which generates statically-sized structs of at most 3 felts). However, there is **no cap on `value.len()`** in `_apply_write_once` itself. A malicious or misconfigured server could craft a `WriteOnceInput` with more than 255 felts, causing storage corruption or an opaque panic.

**Severity:** Medium — not reachable through the standard client path (all structs used are ≤ 3 fields wide), but the invariant is unguarded at the function level. A future struct larger than 255 fields, or any direct `apply_actions` caller bypassing `compile_and_panic`, could exploit this.

**Recommended fix:** Add `assert(value.len() <= MAX_WRITE_ONCE_LEN, internal_errors::VALUE_TOO_LONG)` before the loop, where `MAX_WRITE_ONCE_LEN` is a small constant (e.g., 8).

---

## Finding 5 (REAL FINDING — LOW): `MULTIPLE_DEPOSITORS` Error Constant Is Dead Code

**File:** `packages/privacy/src/errors.cairo:54`

```cairo
pub const MULTIPLE_DEPOSITORS: felt252 = 'MULTIPLE_DEPOSITORS';
```

This constant is defined but never referenced anywhere in the codebase. A `grep -r MULTIPLE_DEPOSITORS packages/privacy/src/` confirms it appears only in `errors.cairo`.

**Analysis:** The `_apply_actions` loop permits multiple `Invoke` actions in a single transaction, each with a potentially different `contract_address` (depositor). The existence of `MULTIPLE_DEPOSITORS` suggests a removed or never-completed enforcement that only one depositor address may appear per `apply_actions` call. Without this constraint, a transaction could invoke two different anonymizer contracts; each `blocked_depositors` check fires independently. The `test_open_note_multiple_depositors` test (test_server.cairo:2080) explicitly validates that multiple depositors are allowed, suggesting the intent is to permit them — making this dead code a cleanup oversight.

**Impact:** No security impact as-is. Dead code causes confusion for future auditors and maintainers.

---

## Finding 6 (REAL FINDING — LOW): `UNEXPECTED_ZERO_VALUE` Only Checks `value[0]`

**File:** `packages/privacy/src/privacy.cairo`, `_apply_write_once`

```cairo
assert(!value.is_empty(), internal_errors::UNEXPECTED_EMPTY_VALUE);
assert(value[0].is_non_zero(), internal_errors::UNEXPECTED_ZERO_VALUE);
```

Only `value[0]` (the first word) is checked for non-zero before iterating. For an open note `Note { packed_value, token }`, `value[0] = packed_value` is guaranteed non-zero (OPEN_NOTE_SALT = 1 ensures `packed_value = 2^128 > 0`). But `value[1] = token` is not checked here — a zero token would slip through the write-once guard undetected.

In practice, `CreateOpenNoteInputValid::assert_valid` guards `token.is_non_zero()` upstream. However, `_apply_write_once` is a general-purpose mechanism that relies entirely on caller discipline for slots beyond index 0. A crafted `WriteOnceInput` submitted directly to `apply_actions` (bypassing client compilation) could write a zero-token open note.

**Severity:** Low — currently not exploitable via the standard flow (gated by client compilation proof path), but represents a defense-in-depth gap.

---

## Summary Table

| # | Area | Severity | Status |
|---|------|----------|--------|
| 1 | `Note` Serde/Store alignment | None | Correct and tested |
| 2 | `EncPrivateKey` Serde/Store alignment | None | Correct and tested |
| 3 | `storage_path_to_felt252` base address correctness | None | Correct — returns offset-0 address |
| 4 | Offset `u8` overflow in `_apply_write_once` for long spans | **Medium** | **Bug — no bound check on `value.len()`** |
| 5 | `MULTIPLE_DEPOSITORS` defined but never used | Low | Dead code — remove or reimplement |
| 6 | `UNEXPECTED_ZERO_VALUE` only checks `value[0]` | Low | Defense-in-depth gap — non-zero check only on first felt |
