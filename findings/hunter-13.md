# Bug Hunter #13 — Ekubo Swap Anonymizer Findings

## Scope

- `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`
- `packages/ekubo_swap_anonymizer/src/tests/test_ekubo_swap_anonymizer.cairo`
- `packages/ekubo_swap_anonymizer/src/tests/test_utils.cairo`
- `packages/privacy/src/tests/test_ekubo_swap_anonymizer.cairo`
- `packages/privacy/src/privacy.cairo` (`_apply_invoke`, `_deposit_to_open_note`)

---

## Bug 1 — CRITICAL: Missing token pre-transfer from privacy contract to anonymizer

### Description

`privacy_invoke` immediately calls `checked_transfer(in_token, router_addr, in_amount)`, which
transfers `in_amount` of `in_token` FROM the anonymizer contract TO the router. This requires the
anonymizer to already hold those tokens before `privacy_invoke` is called.

The privacy contract's `_apply_invoke` (privacy.cairo:870-881) only does a bare
`call_contract_syscall(address: contract_address, entry_point_selector: INVOKE_SELECTOR, calldata)`.
There is **no preceding `checked_transfer` or `checked_transfer_from`** that moves tokens from the
privacy contract to the anonymizer before calling it.

### How it actually works — the precondition is external

Reading the interface doc comment (ekubo_swap_anonymizer.cairo:46-47):

> **Preconditions**
> - The anonymizer must hold at least `token_amount.amount` of `token_amount.token`.

And confirmed by every test — including the integration test
`test_ekubo_privacy_invoke_via_privacy_contract` (privacy/src/tests/test_ekubo_swap_anonymizer.cairo:191):

```cairo
input_token.supply(address: ekubo_anonymizer.address, amount: swap_amount);
```

The anonymizer is funded **externally**, before `apply_actions` is called. The privacy contract's
`Invoke` path trusts that whoever set up the `InvokeExternal` client action arranged for the
anonymizer to be funded out-of-band (e.g., the user or a relayer sent tokens directly to the
anonymizer address before submitting the server transaction).

### Risk

This is not a code bug — it is a documented precondition. However, it is an **integration hazard**:

- If the anonymizer is not pre-funded, `checked_transfer` will panic (insufficient balance) and
  the entire `apply_actions` transaction reverts. This is safe; no funds are lost.
- The open note created in the same `apply_actions` call (`CreateOpenNote` comes before `Invoke` in
  the client action ordering, and both land in the same `actions` span) will also revert. So there
  is no orphaned open note left in storage in case the funding step was missed.
- There is NO mechanism within the protocol to atomically fund the anonymizer as part of the same
  `apply_actions` call. The user must coordinate the two steps: (1) send `in_token` to the
  anonymizer address, then (2) submit the `apply_actions` transaction. A front-runner who observes
  step 1 on-chain could — in principle — call `privacy_invoke` on the anonymizer directly before
  the legitimate `apply_actions` arrives, burning the user's funds. Callers of `privacy_invoke`
  are not authenticated.

### Verdict

Not a contract bug per se (the precondition is documented), but the **lack of caller authentication
on `privacy_invoke`** combined with the external pre-funding requirement creates a
**front-running / griefing vector** where a third party can drain the anonymizer's in-token balance
into a swap for a note they control, before the legitimate `apply_actions` is executed.

---

## Bug 2 — `balance_before` measurement is correct, not a bug

### Description

The investigation noted concern that `balance_before` is measured after `clear(in_token)` but
before `clear_minimum(out_token)`. In the real Ekubo protocol, the router holds output tokens until
`clear` is called; output is only transferred to the caller during `clear_minimum`. Therefore:

- `balance_before` (line 146) is always the anonymizer's pre-existing out_token balance, excluding
  any tokens not yet cleared from the router.
- `clear_minimum` (line 147-151) triggers the transfer of output tokens from the router to the
  anonymizer.
- `balance_after` (line 153) captures the new balance after the transfer.

The delta `balance_after - balance_before` accurately measures exactly how many out tokens
`clear_minimum` delivered. This is the correct and intended pattern.

**No bug here.**

---

## Bug 3 — Approval amount matches deposit amount; no over-transfer risk

### Description

`out_erc20.approve(spender: privacy_addr, amount: out_amount.into())` sets allowance to exactly
`out_amount` (u128, widened to u256). The privacy contract then calls:

```cairo
checked_transfer_from(token_address: token, sender: depositor, recipient: ..., amount: amount.into())
```

where `amount = deposit.amount = out_amount` (same u128). The transfer amount equals the approved
amount exactly, so the `transferFrom` will succeed and consume the full allowance. No over-approval.

**No bug here.**

---

## Bug 4 — `clear(in_token)` correctly catches partial fills, including the returned tokens

### Description

In `PartialSwap` mode, the mock AMM burns only half the input tokens (transfers them to
`DEAD_ADDRESS`). The remaining half stays on the router. When `clear(in_token)` is called, it
returns that remaining half as a non-zero `u256`, the assertion `in_token_remaining.is_zero()`
fires, and the whole transaction reverts (including the half-burned tokens, since the entire tx
reverts atomically).

On the real Ekubo router, `clear` transfers remaining tokens back to the caller (the anonymizer)
before returning the balance. If the assert were placed after the clear call without reverting,
the anonymizer would silently accumulate unreturned in-tokens. But because the assert is a panic,
the entire transaction reverts and no state change persists.

**No bug here.** The assertion effectively enforces that no partial fills are accepted.

---

## Bug 5 — `minimum_received` type boundary edge case (informational)

### Description

`minimum_received` is `u256`. The actual output captured as `out_amount` is `u128`. If
`minimum_received > u128::MAX` and the actual output is within u128 range, then
`clear_minimum` will revert with `CLEAR_MINIMUM_NOT_MET` before the anonymizer even checks
`RECEIVED_AMOUNT_OVERFLOW`. This is safe (no funds lost; tx reverts). Conversely, if the output
genuinely exceeds u128 (an extremely large swap), `RECEIVED_AMOUNT_OVERFLOW` fires.

The combination is consistent: callers cannot set `minimum_received > 2^128-1` and expect a
successful swap if the output is u128-bounded. This is a documentation gap (the interface doc does
not mention the u128 ceiling on `minimum_received` for it to be reachable), but not a security bug.

**No bug here;** informational only.

---

## Bug 6 — Unauthenticated `privacy_invoke` entrypoint (front-running / griefing)

### Description (expanded from Bug 1)

`privacy_invoke` has no access control. Any caller can invoke it, not only the privacy contract.
The precondition states the anonymizer must be pre-funded. An adversary who observes a user
funding the anonymizer on-chain can:

1. Send a `privacy_invoke` call directly (not through the privacy contract) specifying a
   `note_id` they control.
2. The swap executes: `in_token` leaves the anonymizer, `out_token` arrives and is approved to
   `get_caller_address()` (the adversary's address, not the privacy contract).
3. The adversary calls `transferFrom` to pull the out-tokens to themselves.
4. The victim's subsequent `apply_actions` transaction finds the anonymizer unfunded and reverts.
   The victim loses their `in_token` (which the adversary burned in step 2).

### Severity

**HIGH** — results in permanent loss of user funds (the `in_token` that was pre-sent to the
anonymizer is consumed in an adversary-controlled swap and the output approved to the adversary).

### Fix

Add caller authentication: assert that `get_caller_address() == privacy_contract_address`.
Since the anonymizer is stateless, the privacy contract address would need to be either:
- A constructor argument stored in (currently empty) storage, or
- Derived from a hardcoded or immutable address.

Alternatively, structure the flow so that the anonymizer is funded atomically by the privacy
contract (e.g., the privacy contract transfers `in_token` to the anonymizer immediately before
making the syscall), eliminating the window for front-running.

---

## Bug 7 — `Noop` swap mode leaves in-tokens on router but `clear` returns 0, contradicting each other

### Description (mock AMM issue, informational for auditors)

In `SwapBehavior::Noop`, the mock AMM's `swap` function burns all input tokens (transfers them to
`DEAD_ADDRESS`) but `clear_minimum` returns zero without transferring anything. So:

- `clear(in_token)` delegates to `clear_minimum(in_token, 0)`, which returns 0.
- `in_token_remaining.is_zero()` is true, so no panic — the anonymizer proceeds.
- `balance_before = out_erc20.balance_of(self_addr)` = 0 (no output staged).
- `clear_minimum(out_token, 0)` returns 0 (Noop path, no transfer).
- `balance_after` = 0, `out_amount = 0`.
- `ZERO_OUT_AMOUNT` assertion fires.

The test correctly catches this (`test_ekubo_privacy_invoke_assertions`, line 190-202). The mock's
`Noop` semantics are internally consistent for testing zero-output detection.

**No production bug; informational only.**

---

## Summary Table

| # | Finding | Severity | Real Bug? |
|---|---------|----------|-----------|
| 1 | in_token pre-funding is external, not atomic | Architecture | No — documented precondition |
| 2 | balance_before measured before clear_minimum | — | No bug |
| 3 | Approval/transfer amount mismatch | — | No bug |
| 4 | partial fill `in_token_remaining` check | — | No bug |
| 5 | minimum_received u256 vs u128 ceiling | Informational | No (doc gap only) |
| **6** | **Unauthenticated `privacy_invoke`; front-running griefing** | **HIGH** | **YES** |
| 7 | Noop mock behavior | Informational (test mock) | No |
