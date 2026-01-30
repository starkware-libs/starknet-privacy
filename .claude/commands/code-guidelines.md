# Code Guidelines

Apply these guidelines when writing or reviewing code in this codebase.

---

## Naming

### Consistent terminology
- Use the same term for the same concept across parameters, fields, and documentation
- *Example:* If a struct field is `private_key`, use `private_key` everywhere, not `decryption_key` in function parameters

### Disambiguate counts from collections
- When a name represents a count, make that explicit
- *Example:* `n_channels` or `num_channels` instead of just `channels`

---

## Documentation

### Match documentation to code identifiers
- Doc comments should use the exact parameter and field names from the code
- *Example:* If parameter is `addr`, doc should say `addr`, not `recipient_addr`

### Document semantic meaning, not just types
- Clarify behavioral details that the type signature doesn't convey
- *Example:* For indices: inclusive vs exclusive; for optionals: what `None` means; for ranges: whether bounds are included

---

## Edge Cases

### Prefer intuitive semantics over internal convenience
- Design APIs so callers don't need to know implementation details
- *Example:* A `start_index` should work as-is; avoid requiring `start_index + 1` adjustments

### Simplify when defaults add no value
- If `None` just means a default value, consider using a plain type instead
- *Example:* `start_index: u64` with default 0 is simpler than `Option<u64>` where `None` means 0

### Use safe type conversions
- Avoid conversions that silently fail on edge cases
- *Example:* `usize::try_from(value).expect("msg")` instead of `as usize` which truncates on overflow

### Prefer defensive arithmetic
- Use operations that handle edge cases gracefully, even if guards exist
- *Example:* `saturating_sub` instead of subtraction that could underflow if guards are later refactored

---

## Brevity

### Inline expressions that save >2 lines
- Inline expressions where doing so saves more than 2 lines without making the resulting line excessively long
- Prefer `map_or(default, |x| x + 1)` over `map(|x| x + 1).unwrap_or(default)` - it's shorter and more idiomatic
- Use `.or()` to update optional values instead of `if let Some(x) = ... { field = Some(x) }`
- *Example:* `cursor.last_index = result.last_index.or(cursor.last_index);` instead of a 3-line `if let`

### Inline trivial expressions
- Avoid separate `let` bindings for trivial expressions like `.clone()` when used immediately
- Inline directly in function arguments if it doesn't hurt readability
- *Example:* `spawn(foo.clone(), bar.clone())` instead of `let foo = foo.clone(); let bar = bar.clone(); spawn(foo, bar)`

### Check for existing utilities before adding new ones
- Before writing a local helper function, search the codebase for existing shared utilities
- If similar code exists in multiple places, extract to a shared module (e.g., `test_fixtures.rs` for test helpers)
- *Example:* Test helpers like `get_channel_key()` belong in `test_fixtures.rs`, not duplicated in each test module

---

## Comments

### Explain WHY, not WHAT
- Add comments where the reasoning isn't obvious from context
- Focus on decisions, constraints, and non-obvious requirements

### Document implicit structures
- When code relies on conventions or layouts, make them explicit
- *Example:* Storage layouts, protocol-specific ordering, cryptographic choices

---

## Testing

### Never mask test failures
- Failing tests indicate real problems; hiding them hides bugs
- Fix the root cause instead of using `#[ignore]`, `.skip()`, or similar
- *Example:* If a test fails due to stale fixture data, regenerate the fixture - don't ignore the test

### Keep integration test setup minimal
- Inline setup in each test rather than building complex helper structs
- Query dynamic values (addresses, ports) at runtime instead of hardcoding
- *Example:* Instead of `DevnetWithIndexer` helper struct, inline devnet spawn and address queries directly in each test

### Cover edge cases systematically
- Test boundary conditions, empty inputs, and failure modes
- *Example:* For pagination, test with no items, exactly one page, and partial pages

### Use accurate test names
- Test names should precisely describe the scenario being verified
- *Example:* `test_empty_collection` vs `test_no_new_items` convey different conditions

### Match assertions to fixture guarantees
- Only assert on data presence when the fixture explicitly guarantees that data exists
- For structural/protocol tests, verify correctness of whatever data is returned without assuming specific content
- *Example:* Assert `channels_done == true` (protocol correctness) separately from asserting `!channels.is_empty()` (data presence)

### Verify base state before debugging failures
- When a test fails unexpectedly, first verify the code at HEAD actually compiles and tests pass
- Broken imports or syntax errors can mask that tests were never working
- *Example:* `git stash && cargo build` to check if the original code even compiles before investigating test logic

---

## WIP: Guidelines to add

- [ ] Error handling patterns
- [ ] Async patterns
- [ ] Trait design
- [ ] Module organization
