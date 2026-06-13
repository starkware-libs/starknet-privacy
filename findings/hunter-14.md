# Bug Hunter #14 — Findings for `ekubo_swap_anonymizer.cairo`

Target file: `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`
Test file: `packages/ekubo_swap_anonymizer/src/tests/test_ekubo_swap_anonymizer.cairo`

---

## Finding 1 — `balance_before / balance_after` subtraction: SAFE

**Area:** `out_token` balance calculation when the anonymizer already holds residual `out_token`.

**Analysis:**

```cairo
let balance_before = out_erc20.balance_of(account: self_addr);
clear.clear_minimum(token: EkuboIERC20Dispatcher { contract_address: out_token }, minimum: minimum_received);
let balance_after = out_erc20.balance_of(account: self_addr);
let out_amount: u128 = (balance_after - balance_before)
    .try_into()
    .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
```

`clear_minimum` on the Ekubo router transfers the router's balance of `out_token` to the caller (the anonymizer). It can only **add** tokens to the anonymizer, never remove them. Therefore `balance_after >= balance_before` always holds.

- If `balance_before > 0` (residual from a prior stuck invocation), the delta still correctly captures only the newly received tokens. This is intentional and correct.
- `balance_after < balance_before` is impossible given the semantics of `clear_minimum`. The subtraction is safe.
- The `try_into()` with `RECEIVED_AMOUNT_OVERFLOW` correctly gates the result to `u128`. A test for this case exists (`RECEIVED_AMOUNT_OVERFLOW` test in `test_ekubo_privacy_invoke_assertions`).

**Verdict: No bug.**

---

## Finding 2 — `clear(in_token)` before `clear_minimum(out_token)`: SAFE

**Area:** Ordering of `clear` and `clear_minimum` calls on the router.

**Analysis:**

The operation sequence is:
1. Transfer `in_token` to router.
2. Call `router.swap(...)`.
3. `clear.clear(in_token)` — reclaims any unswapped `in_token` from the router back to the anonymizer.
4. Assert `in_token_remaining == 0` (enforcing a full fill).
5. `clear_minimum(out_token)` — reclaims `out_token` from the router to the anonymizer.

Steps 3 and 5 operate on **different tokens** (`in_token` vs `out_token`). These are distinct ERC-20 balances on the router; clearing `in_token` has no effect on the router's `out_token` balance. The ordering is safe regardless of router internals.

The only concern would arise if `in_token == out_token`, but this is impossible: `out_token` is derived as the pool token that is **not** `in_token`, so they are always distinct (assuming a valid pool key with two different tokens — see Finding 4 below for the edge case where `token0 == token1`).

**Verdict: No bug (with caveat addressed in Finding 4).**

---

## Finding 3 — `i129` sign convention and `NEGATIVE_AMOUNT` check: CORRECT

**Area:** `assert(!sign, errors::NEGATIVE_AMOUNT)` — sign semantics.

**Analysis:**

From the Ekubo source (`src/types/i129.cairo`, revision `8b4de8b5`):

```cairo
pub struct i129 {
    pub mag: u128,
    pub sign: bool,
}
```

`sign = true` means **negative** (sign-magnitude representation; `is_negative()` returns `self.sign & self.mag.is_non_zero()`). The conversion from `i128` assigns `sign: true` for values `< 0`.

The assertion `assert(!sign, errors::NEGATIVE_AMOUNT)` therefore correctly rejects `sign = true` (negative amounts). A value of `i129 { mag: 0, sign: true }` would pass this check, but it is then caught by `assert(in_amount.is_non_zero(), errors::ZERO_IN_AMOUNT)`, closing the gap.

The test `test_ekubo_privacy_invoke_assertions` explicitly verifies that `i129 { mag: DEFAULT_AMOUNT, sign: true }` triggers `NEGATIVE_AMOUNT`.

**Verdict: No bug.**

---

## Finding 4 — `out_token` derived from pool key with no zero-address guard: REAL BUG (LOW SEVERITY)

**Area:** `pool_key.token0` / `pool_key.token1` can be zero; `out_token` is never checked for zero.

**Analysis:**

```cairo
let out_token = if in_token == pool_key.token0 {
    pool_key.token1
} else {
    assert(in_token == pool_key.token1, errors::TOKEN_MISMATCH_POOL_KEY);
    pool_key.token0
};
```

There is a check `assert(in_token.is_non_zero(), errors::ZERO_IN_TOKEN)`, but **no corresponding check on `out_token`** after derivation.

**Attack scenario:**
- Caller supplies `pool_key = { token0: in_token, token1: 0, fee: 0, tick_spacing: 1, extension: 0 }`.
- `in_token == pool_key.token0`, so `out_token = pool_key.token1 = 0`.
- The contract calls `IERC20Dispatcher { contract_address: 0 }.balance_of(...)`, then `clear_minimum` with address 0 as the token, and finally `approve(spender: privacy_addr, amount: ...)` on address 0.

On Starknet, dispatching to address 0 is technically invalid and will revert. However, the error message will be a low-level syscall failure rather than a descriptive error like `ZERO_OUT_TOKEN`, making debugging harder and providing a worse developer/integrator experience.

More importantly, if Starknet ever behaves differently at address 0 (or if a future upgrade changes syscall semantics), this becomes a silent misbehavior path. Defensive programming requires an explicit guard.

**Symmetric case:** If `in_token == pool_key.token1` and `pool_key.token0 == 0`, then `out_token = 0`. Same issue.

**Also missing:** No check that `pool_key.token0 != pool_key.token1`. If they are equal (and both equal `in_token`), the branch `in_token == pool_key.token0` fires, and `out_token = pool_key.token1 = in_token`. The contract would then try to swap a token for itself, which is nonsensical. The router call would likely revert, but again the error is non-descriptive.

**Recommended fix:**

Add after `out_token` derivation:

```cairo
assert(out_token.is_non_zero(), 'ZERO_OUT_TOKEN');
```

And optionally:

```cairo
assert(out_token != in_token, 'SAME_IN_OUT_TOKEN');
```

**Verdict: Bug — missing `out_token` zero check. Low severity (Starknet reverts on dispatch to address 0 in practice), but should be fixed for robustness and clear error messages.**

---

## Finding 5 — `out_token` zero redundant with Finding 4: already covered

See Finding 4. The specific path where `pool_key.token1 = 0` and `in_token == pool_key.token0` results in `out_token = 0`. No additional analysis needed.

**Verdict: Covered by Finding 4.**

---

## Finding 6 — Reentrancy via `approve` after balance snapshot: SAFE in current Starknet

**Area:** Could a reentrant call between `balance_after` measurement and `approve` drain the anonymizer?

**Analysis:**

The sequence:
1. `balance_after = out_erc20.balance_of(...)` 
2. `out_amount = balance_after - balance_before`
3. `out_erc20.approve(spender: privacy_addr, amount: out_amount.into())`
4. Return `[OpenNoteDeposit { note_id, token: out_token, amount: out_amount }].span()`

Starknet executes transactions sequentially with no preemption between contract calls within a transaction. There is no OS-level thread concurrency; only reentrancy via cross-contract calls within the same transaction is possible. The `approve` call itself dispatches into the ERC-20 contract, which does not call back into the anonymizer.

Even if the ERC-20 implementation were malicious and called back into the anonymizer, the anonymizer has no state and no lock, but the callback would be a fresh `privacy_invoke` call with its own arguments — it would not alter the currently executing frame's `out_amount`.

**Verdict: No bug under current Starknet execution model.**

---

## Finding 7 — No access control on `privacy_invoke`: ACKNOWLEDGED NON-BUG

**Area:** Any account can call `privacy_invoke` directly, not just the privacy contract.

**Analysis:**

The anonymizer holds **no persistent token balances** by design (it is a transient intermediary). The caller (`privacy_addr = get_caller_address()`) receives the `approve` for `out_amount`, and the returned `OpenNoteDeposit` span is only acted upon by the privacy contract.

If a non-privacy-contract caller invokes `privacy_invoke`:
- They must pre-fund the anonymizer with `in_token` (the `checked_transfer` from the anonymizer to the router requires the anonymizer to hold the tokens).
- They receive an `approve` for `out_token` but must then separately call `transferFrom` to claim it.
- The `OpenNoteDeposit` return value is useless to them without the privacy contract.

The anonymizer accumulates no residual value. A direct caller cannot extract value beyond what they put in (modulo the swap). This is an intentional design tradeoff documented in the interface: "One deployed instance can be used with multiple Ekubo pools by passing pool and route params in calldata."

**Verdict: No bug. The stateless design makes access control unnecessary.**

---

## Summary Table

| # | Area | Verdict |
|---|------|---------|
| 1 | `balance_before/after` subtraction safety | Safe |
| 2 | `clear(in_token)` before `clear_minimum(out_token)` ordering | Safe |
| 3 | `i129` sign convention — `NEGATIVE_AMOUNT` check | Correct |
| 4 | `out_token` never checked for zero (derived from pool key) | **Bug — LOW severity** |
| 5 | `out_token` zero (redundant path) | Covered by #4 |
| 6 | Reentrancy between balance snapshot and `approve` | Safe |
| 7 | No access control on `privacy_invoke` | Acknowledged, not a bug |

---

## Actionable Recommendation

**Finding 4** is the only actionable bug. Add an explicit `ZERO_OUT_TOKEN` assertion immediately after deriving `out_token` (line 124 in the main file), and consider adding a `SAME_IN_OUT_TOKEN` guard. Both are one-liners. Tests for these guards should be added to `test_ekubo_privacy_invoke_assertions`.
