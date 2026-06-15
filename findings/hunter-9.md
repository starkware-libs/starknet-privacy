# Bug Hunt Report — Hunter 9
## Target: `packages/ekubo_swap_anonymizer/src/ekubo_swap_anonymizer.cairo`

---

## Finding 1: Stale ERC20 Approval — Tokens Permanently Stuck if Approval Overwritten (Medium)

**Location:** `ekubo_swap_anonymizer.cairo` lines 159–160

```cairo
out_erc20.approve(spender: privacy_addr, amount: out_amount.into());
[OpenNoteDeposit { note_id, token: out_token, amount: out_amount }].span()
```

**Root cause:** The anonymizer calls `approve(privacy_addr, out_amount)` unconditionally. This *sets* (not increments) the ERC20 allowance to exactly `out_amount`. If the anonymizer previously held a non-zero balance of `out_token` from an earlier swap whose approval was never consumed, the new `approve` overwrites the old allowance. The privacy contract can now only pull `out_amount`, leaving the older accumulated tokens permanently locked in the anonymizer with no recovery path.

**Can tokens actually accumulate?** In production, the privacy contract atomically calls `transfer_from(anonymizer, privacy, out_amount)` in the same `apply_actions` transaction as the `Invoke` action, so the approval is always consumed. However, two scenarios break this guarantee:

1. **The anonymizer is called directly** (not through the privacy contract). `privacy_addr = get_caller_address()` would be the direct caller. If that caller does not immediately invoke `transfer_from`, the tokens and approval are left on the anonymizer. Any subsequent `privacy_invoke` call for the same `out_token` will overwrite the approval with the new, smaller `out_amount`, leaving the original balance permanently inaccessible.

2. **Multiple `Invoke` actions in one `apply_actions` call targeting the same anonymizer**. While the server validates `open_note_deposits.len()` against `undeposited_open_notes`, if two `Invoke` actions return deposits for the same `out_token`, the second `privacy_invoke` call runs (setting its own approval) while the first deposit's `transfer_from` has already consumed the first approval. The second deposit will correctly consume its own approval. This case is actually handled correctly, but only because the deposits are applied sequentially with `transfer_from` called after each `Invoke` — confirmed by reading `_apply_actions`.

**Production risk assessment:** Low under the current privacy contract design (atomic consumption), but the anonymizer contract itself has no self-protection: it has no access control on `privacy_invoke`, no token-recovery function, and the `approve` is a set (not accumulate). If any future caller fails to consume the approval, tokens are stuck with no recourse.

**Recommendation:** After the swap and deposit, call `approve(privacy_addr, 0)` to reset the allowance, or use an `increaseAllowance`/`decreaseAllowance` pattern. Alternatively, add a `transfer_remaining(token, recipient)` admin function to recover stuck tokens.

**Test gap:** The unit test `test_ekubo_same_anonymizer_different_pool` (lines 60–99 in `test_ekubo_swap_anonymizer.cairo`) calls `privacy_invoke` twice and asserts that `token_b` remains on the anonymizer after the first call (line 84: `assert_eq!(token_b.balance_of(address: anonymizer.address), swap_amount.into())`). This explicitly tests the accumulation case but normalizes it as expected behavior, hiding the stuck-funds risk.

---

## Finding 2: `pool_key.token0 == pool_key.token1` Allows `in_token == out_token` Bypass (Low / Defense-in-Depth Gap)

**Location:** `ekubo_swap_anonymizer.cairo` lines 119–124

```cairo
let out_token = if in_token == pool_key.token0 {
    pool_key.token1
} else {
    assert(in_token == pool_key.token1, errors::TOKEN_MISMATCH_POOL_KEY);
    pool_key.token0
};
```

**Root cause:** If a caller passes `pool_key.token0 == pool_key.token1 == in_token`, the condition `in_token == pool_key.token0` is true, so `out_token = pool_key.token1 = in_token`. There is no assertion that `out_token != in_token`.

**What actually happens:** With a same-token pool, `clear(in_token)` and `clear_minimum(out_token)` both operate on the same token. The first `clear` returns any unconsumed input back to the anonymizer. The second `clear_minimum` finds the router has 0 balance (already cleared) and transfers 0. Result: `out_amount = 0`, and the function reverts with `ZERO_OUT_AMOUNT`.

So the degenerate same-token case *is* caught, but only accidentally by a downstream assertion rather than an explicit guard.

**Interaction with malicious router:** A malicious `router_addr` could construct `clear(in_token)` to return 0 (passing the `IN_TOKEN_NOT_CLEARED` check) while retaining the tokens, and then in `clear_minimum(out_token = in_token)`, actually transfer in_token back to the anonymizer. In this scenario, `balance_before` would be the anonymizer's in_token balance after transferring `in_amount` to the router (possibly 0 if the anonymizer had exactly `in_amount`), and `balance_after` would be `in_amount` (the tokens returned). `out_amount = in_amount`. The function would succeed, approving the caller to pull `in_amount` of the same token that was sent in — a no-op swap that looks like a successful swap. This requires a fully malicious router, so it's in the attacker-controlled-router threat model, not an ambient vulnerability.

**Recommendation:** Add `assert(out_token != in_token, SAME_TOKEN)` immediately after deriving `out_token`. This is cheap and eliminates an entire class of degenerate input without depending on downstream assertions.

---

## Finding 3: No Test for Pre-Existing `out_token` Balance on Anonymizer (Test Coverage Gap)

**Location:** `test_ekubo_swap_anonymizer.cairo` (all tests)

**Claim in bug-hunt prompt:** "If the anonymizer already held some `out_token` balance BEFORE this invocation, `balance_before` would be non-zero, and `balance_after - balance_before` would correctly compute only the NEWLY received amount. This is correct."

**Verification:** This claim is correct. The balance-delta approach (`balance_after - balance_before`) correctly isolates the newly received tokens regardless of any pre-existing out_token balance. No test in either the unit suite (`test_ekubo_swap_anonymizer.cairo`) or the integration suite (`privacy/src/tests/test_ekubo_swap_anonymizer.cairo`) exercises this case.

The absence of a test is worth flagging: the pre-existing-balance scenario is precisely what would occur if Finding 1's stale-approval scenario materializes (anonymizer holds leftover out_token). The balance-delta formula would correctly compute the new `out_amount`, but the `approve` would set the allowance to only the new `out_amount`, leaving the old balance inaccessible (as described in Finding 1). A test that pre-seeds the anonymizer with `out_token` and then runs a swap would help document and verify both the correctness of the delta and the stuck-funds implication.

---

## Finding 4: `clear_minimum` Return Value Semantics Are Inconsistent with Stated Rationale (Informational)

**Location:** `ekubo_swap_anonymizer.cairo` lines 144–151

```cairo
// Ignore the return value of clear_minimum. We calculate the output amount below.
let balance_before = out_erc20.balance_of(account: self_addr);
clear.clear_minimum(
    token: EkuboIERC20Dispatcher { contract_address: out_token },
    minimum: minimum_received,
);
let balance_after = out_erc20.balance_of(account: self_addr);
let out_amount: u128 = (balance_after - balance_before)
    .try_into()
    .expect(errors::RECEIVED_AMOUNT_OVERFLOW);
```

The comment says the return value is ignored because the balance delta is used instead. This is correct and intentional. The balance-delta approach is strictly more robust: `clear_minimum` could return a value different from what was actually transferred (e.g., it returns a cached value), while `balance_of` queries the true on-chain state. This is a sound design choice. No bug.

However, the code trusts that `out_erc20.balance_of` accurately reflects the anonymizer's balance after `clear_minimum`. A malicious `out_token` ERC20 could manipulate `balanceOf` independently of actual transfers. This is a general ERC20 trust assumption shared by all DeFi contracts, not specific to this anonymizer.

---

## Summary

| # | Title | Severity | Real Bug? |
|---|-------|----------|-----------|
| 1 | Stale approval: `approve` overwrites previous allowance, stuck tokens no recovery | Medium | Yes (edge case, no recovery path) |
| 2 | No `in_token != out_token` assertion; degenerate pool passes | Low | Defense gap (caught by downstream assert) |
| 3 | No test for pre-existing out_token balance on anonymizer | Test gap | Yes |
| 4 | `clear_minimum` return value ignored — rationale is sound | Informational | No |

**Verified as NOT bugs (prompt claims confirmed correct):**
- Balance-delta correctly isolates newly received amount even with pre-existing balance (Finding 3 confirms this is untested but correct)
- `router.swap(:node, :token_amount)` passing original struct is fine (Cairo passes by value; struct is valid)
- `balance_after - balance_before` underflow: impossible in normal operation (`clear_minimum` can only add tokens to anonymizer's balance, not remove them); if it somehow triggered, Cairo u256 subtraction panics cleanly
- `clear_minimum` return value being ignored is correct — balance delta is the right approach
