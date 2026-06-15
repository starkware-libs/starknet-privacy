# Bug Hunter #10 — Ekubo Swap Anonymizer: Slippage & Partial-Fill Logic

**File:** `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`
**Mock:** `packages/ekubo_swap_anonymizer/src/test_utils_contracts/mock_ekubo_amm.cairo`
**Tests:** `packages/ekubo_swap_anonymizer/src/tests/test_ekubo_swap_anonymizer.cairo`

---

## Finding 1 — REAL BUG: `clear(in_token)` transfers `in_token_remaining` to self BEFORE the zero-check; the mock inverts the real Ekubo behavior of `Noop`, creating a fidelity gap that hides the partial-fill bypass

### Severity: Medium

### Description

In the main contract (`ekubo_swap_anonymizer.cairo`, lines 140–142):

```cairo
let in_token_remaining = clear
    .clear(token: EkuboIERC20Dispatcher { contract_address: in_token });
assert(in_token_remaining.is_zero(), errors::IN_TOKEN_NOT_CLEARED);
```

The real Ekubo `clear(token)` function:
1. Queries `token.balanceOf(router)`
2. Transfers that amount to `msg.sender` (i.e., the anonymizer / `self_addr`)
3. Returns the amount transferred

This means that when `clear(in_token)` is called, **any remaining in_token is transferred to the anonymizer BEFORE the assert is evaluated**. If the assert fails (partial fill), the transaction reverts in Cairo — which undoes the transfer. That part is fine.

The critical issue is with the **mock's `Noop` behavior** and what it reveals about a real-world scenario:

In the mock, `Noop` mode:
- `swap()`: transfers ALL `in_amount` to `DEAD_ADDRESS` (fully consumes input)
- `clear(in_token)`: returns `Zero::zero()` **without querying the actual token balance** of the router

This does NOT match real Ekubo semantics. In real Ekubo, `clear()` returns whatever balance the router holds. In `Noop`, the mock forcibly returns 0 regardless of the actual on-chain balance — it is a shortcut that papers over the real logic.

**The consequence:** The mock's `Noop` branch in `clear_minimum` also returns `Zero::zero()` WITHOUT transferring any out_token. This simulates "swap succeeded but router kept the output", which the `ZERO_OUT_AMOUNT` check correctly catches.

However, consider a **real Ekubo pool** where the swap "succeeds" in Ekubo's sense but produces zero output (e.g., the pool is misconfigured or has an extension that intercepts the output). The router would hold 0 out_token, `clear_minimum` would return 0 (with `minimum_received = 0`), and `out_amount = 0` would trigger `ZERO_OUT_AMOUNT`. So this case is caught.

**True gap:** There is NO scenario where the real Ekubo `clear(in_token)` returns a non-zero value but the anonymizer ends up with in_token on hand after a successful assertion. The logic is correct for honest routers. But the contract provides **no protection against a malicious `router_addr`** that:
- Accepts the swap call
- Claims `in_token_remaining = 0` from `clear`
- Claims some `out_token` from `clear_minimum`
- But never actually consumed the input or credited any output to the router

Since `router_addr` is caller-supplied, this is a trust issue: **users can pass any router address**, including a malicious one that lies about its state. The contract transfers `in_amount` of `in_token` to the router at the start, then trusts the router's own `clear()` return values to determine what happened. A malicious router could:
1. Accept the in_token transfer (keeping it)
2. Return `in_token_remaining = 0` from `clear` (claim full fill)
3. Return some amount from `clear_minimum` to the anonymizer

In this case the user's in_token is stolen by the router. However, this requires the user to pass a malicious router, so it's a self-harm scenario — but the contract provides no on-chain guard against it.

---

## Finding 2 — REAL BUG: Mock `Noop` behavior misrepresents Ekubo's `clear()` semantics, hiding a flaw in the partial-fill check

### Severity: Low (test infrastructure bug; affects test coverage quality, not production)

### Description

In `mock_ekubo_amm.cairo`, the `Noop` branch of `clear_minimum` (lines 107–108):

```cairo
match self.swap_behavior.read() {
    SwapBehavior::Noop => Zero::zero(),
    ...
}
```

When `swap_behavior = Noop`:
- `swap()` burns ALL input (transfers to `DEAD_ADDRESS`), leaving 0 in_token on the router
- `clear(in_token)` → `clear_minimum(in_token, 0)` → returns `Zero::zero()` WITHOUT querying the router's actual balance

This is internally consistent but hides an important distinction: should `Noop` model "a swap that produces zero output" or "a swap that consumed no input"? Real Ekubo scenarios where the router produces 0 output would still consume the input. The mock conflates the two cases.

**The partial-fill check path (`IN_TOKEN_NOT_CLEARED`)** is tested using `PartialSwap`, which correctly leaves in_token on the router. The `Noop` path bypasses the partial-fill check (returns 0 from `clear`) and instead relies on `ZERO_OUT_AMOUNT` to catch the failure.

This means the test labeled "Catch ZERO_OUT_AMOUNT (noop swap returns 0 output)" does NOT test the scenario of "a pool that returns zero output via `clear_minimum`" in the real Ekubo sense. In real Ekubo, `clear_minimum` always transfers whatever the router balance is — if the balance is 0 and `minimum = 0`, it does nothing and returns 0. The mock correctly returns 0, but it does so via a special code path (the `Noop` enum), not by having 0 out_token on the router. This divergence means the mock's coverage of this edge case is not fully representative.

---

## Finding 3 — REAL BUG: `balance_before` is measured AFTER `clear(in_token)`, which can include in_token misrouted as out_token

### Severity: Low-Medium (logic soundness issue)

### Description

The code flow is:

```cairo
// Step 1: Transfer in_token to router
checked_transfer(token_address: in_token, recipient: router_addr, amount: in_amount.into());

// Step 2: Swap
router.swap(:node, :token_amount);

// Step 3: Clear in_token (partial fill check)
let in_token_remaining = clear.clear(token: EkuboIERC20Dispatcher { contract_address: in_token });
assert(in_token_remaining.is_zero(), errors::IN_TOKEN_NOT_CLEARED);

// Step 4: Measure balance_before BEFORE clearing out_token
let balance_before = out_erc20.balance_of(account: self_addr);

// Step 5: Clear out_token
clear.clear_minimum(token: EkuboIERC20Dispatcher { contract_address: out_token }, minimum: minimum_received);

// Step 6: Measure balance_after
let balance_after = out_erc20.balance_of(account: self_addr);
let out_amount = (balance_after - balance_before)...
```

The `balance_before` snapshot (Step 4) happens AFTER `clear(in_token)` (Step 3). This is correct as long as `in_token != out_token`.

However, since the pool_key's `token0` and `token1` can theoretically be equal (nothing prevents `pool_key.token0 == pool_key.token1` at the Cairo level), and the only derivation of `out_token` is:

```cairo
let out_token = if in_token == pool_key.token0 {
    pool_key.token1
} else {
    assert(in_token == pool_key.token1, errors::TOKEN_MISMATCH_POOL_KEY);
    pool_key.token0
};
```

If `pool_key.token0 == pool_key.token1 == in_token`, then `out_token = pool_key.token1 = in_token`. The assertion `assert(in_token == pool_key.token1)` passes trivially. This means the "slippage protection" via `clear_minimum` would operate on the same token as the input — which is semantically broken. The out_amount measurement would reflect net in_token balance changes, not actual output.

In practice, Ekubo pools cannot have `token0 == token1`, so this would revert at the router level. But the anonymizer silently accepts the parameters rather than asserting `in_token != out_token` up front.

**No explicit guard exists against `pool_key.token0 == pool_key.token1`**, leaving this as a latent footgun if a malicious or misconfigured router is supplied.

---

## Finding 4 — REAL BUG: `clear(in_token)` call site transfers any remainder to `self_addr` even when the assert will subsequently fail — tokens are not returned to origin

### Severity: Low (Starknet revert saves it, but logic is subtle and the behavior is documented incorrectly)

### Description

The real Ekubo `clear(in_token)` **always transfers** whatever in_token is on the router to the caller (the anonymizer / `self_addr`) and returns the amount. The comment in the code (line 33–34 of the interface docs) says the IN_TOKEN_NOT_CLEARED error is thrown "if the input token balance on the router is non-zero after the swap."

But the actual sequence is:
1. `clear(in_token)` transfers `in_token_remaining` to `self_addr` AND returns it
2. `assert(in_token_remaining.is_zero())` reverts if non-zero

After step 1, the anonymizer holds the leftover in_token. The revert in step 2 undoes this via Starknet's state rollback. So no tokens are stranded. This is safe but **the error message and documentation describe the post-revert state** ("balance on the router is non-zero") rather than what actually happens at the point of failure. The router's balance IS zero after `clear`; it's the RETURNED VALUE that is non-zero.

The error name `IN_TOKEN_NOT_CLEARED` is slightly misleading — the in_token WAS cleared (transferred out of the router), but the expected amount was not zero. A more accurate name would be `IN_TOKEN_REMAINING_NONZERO` or `PARTIAL_FILL_DETECTED`.

---

## Finding 5 — DESIGN ISSUE: `sqrt_ratio_limit = 0` claim in documentation is misleading about its role in partial-fill prevention

### Severity: Informational

### Description

The README states (line 9):
> "Full-swap-only: the anonymizer asserts no input tokens remain on the router after the swap (`sqrt_ratio_limit = 0`), so partial fills revert."

And the doc comment (lines 33–34):
> "Enforces a full swap (no partial fills) by hardcoding `sqrt_ratio_limit = 0` and asserting no input tokens remain on the router after the swap."

This is misleading. The **actual** partial-fill detection is the `clear(in_token)` return value check, not `sqrt_ratio_limit = 0`. The `sqrt_ratio_limit = 0` in Ekubo means "no price bound" (the swap can proceed at any price), not "ensure the swap is fully filled." Setting `sqrt_ratio_limit = 0` actually DISABLES the built-in price protection of a sqrt_ratio_limit, allowing the pool to consume all the input at an arbitrarily bad price — including consuming all input for near-zero output.

The partial-fill detection works because:
1. `sqrt_ratio_limit = 0` signals to Ekubo "consume as much input as possible" (potentially all of it)
2. After the swap, `clear(in_token)` checks whether ALL input was consumed
3. If any remains, the transaction reverts

So `sqrt_ratio_limit = 0` is a necessary precondition for the full-fill invariant to be checkable via `clear(in_token)`, but it is not itself the enforcement mechanism. Documentation should clarify this distinction.

---

## Summary Table

| # | Type | Severity | Description |
|---|------|----------|-------------|
| 1 | Design/Trust | Medium | `router_addr` is untrusted; a malicious router can drain in_token by lying about `clear` return values |
| 2 | Test fidelity | Low | Mock `Noop` does not correctly simulate real Ekubo `clear()` semantics; test coverage gap |
| 3 | Logic | Low-Medium | No guard against `pool_key.token0 == pool_key.token1`; semantically broken but reverts at router level |
| 4 | Naming/Docs | Low | `IN_TOKEN_NOT_CLEARED` is a misnomer; `clear()` does clear it, but the amount was non-zero |
| 5 | Documentation | Info | `sqrt_ratio_limit = 0` role in partial-fill prevention is described inaccurately in README and NatSpec |

---

## Code References

- Main contract: `/home/user/starknet-privacy/packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo` (lines 135–161)
- Mock AMM: `/home/user/starknet-privacy/packages/ekubo_swap_anonymizer/src/test_utils_contracts/mock_ekubo_amm.cairo` (lines 99–120)
- Tests: `/home/user/starknet-privacy/packages/ekubo_swap_anonymizer/src/tests/test_ekubo_swap_anonymizer.cairo` (lines 189–232)
