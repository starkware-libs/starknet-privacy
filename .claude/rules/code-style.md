# Code Guidelines

Apply these guidelines when writing or reviewing code in this codebase.

---

## Naming

### Every name must answer "what is this?"
- A variable name should be a noun or noun phrase that identifies what it holds — readable without surrounding context
- The core test: if you see the name on its own line, can you tell what it represents?

### No standalone adjectives
- Adjectives describe a quality but not the thing itself; always pair with the noun
- *Bad:* `pending`, `remaining`, `discovered`, `complete`, `invalid`
- *Good:* `pending_futures`, `remaining_channels`, `discovered_channels`, `complete_entries`, `invalid_keys`

### No single-letter variables
- Single letters carry no meaning outside of trivial closures passed to stdlib combinators
- *Bad:* `i`, `s`, `n`, `f` as local variables
- *Good:* `channel_offset`, `channel_slots`, `num_items`, `felt_value`
- *Exception:* Single-letter closure params where the type and context make the meaning obvious (e.g., `.map(|x| x + 1)`, `.filter(|c| c.is_complete())`)

### No contractions or abbreviations
- Spell out the full word; the saved keystrokes aren't worth the mental tax on readers
- *Bad:* `ch`, `sc`, `futs`, `addr` (when the domain doesn't use it), `ctx`, `val`
- *Good:* `channel`, `subchannel`, `pending_futures`, `address`, `context`, `value`
- *Exception:* Abbreviations established by the domain (e.g., `addr` in Cairo/StarkNet, `pk` for public key) — follow the domain's convention

### Disambiguate counts from collections
- When a name represents a count, make that explicit with a prefix (`n_`, `num_`) or suffix (`_count`)
- *Bad:* `channels` (is it a Vec or a count?), `total` (total of what?)
- *Good:* `num_channels`, `total_channels`, `channel_count`

### Consistent terminology
- Use the same term for the same concept across parameters, fields, and documentation
- If a term is renamed, rename it everywhere — partial migrations create confusion
- *Example:* If a struct field is `decryption_key`, use `decryption_key` everywhere, not `viewing_key` in some function parameters

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

### Treat all user-provided values as adversarial
- Any value deserialized from an HTTP request, cursor, query parameter, or other external input must be assumed hostile
- Trace user-controlled values through the full call graph and analyze whether they can cause DoS, OOM, panics, or other resource exhaustion
- Cap allocations derived from user input with hard limits (e.g., `const MAX_CAPACITY: usize = 1024`)
- *Example:* A cursor field `total_n_channels: u64` can be set to `u64::MAX` by an attacker; using it directly in `Vec::with_capacity` causes OOM before any budget check runs

### Never panic on data reachable from requests
- Code reachable from HTTP handlers, RPC calls, or any external input must never use `.unwrap()`, `.expect()`, or unchecked indexing on values derived from that input
- Reserve panics for compile-time invariants (hardcoded constants, static strings) where failure is a programmer bug, not a runtime possibility
- For fallible operations: return `Result` with a descriptive error variant, or use saturating/capping alternatives when the exact value doesn't matter
- *Example:* `check_slots_len(&values, 3)?` before indexing a returned Vec

### Prefer intuitive semantics over internal convenience
- Design APIs so callers don't need to know implementation details
- *Example:* A `start_index` should work as-is; avoid requiring `start_index + 1` adjustments

### Expose new options on every API surface that triggers the behavior
- When adding a configurable option to a low-level constructor, thread it through the higher-level factory/builder that wraps it — especially if the option changes default behavior. An escape hatch that only exists on a surface most callers don't use is not a real escape hatch
- *Example:* A `retry` option added to a service constructor must also be reachable from the `createX` factory config; otherwise factory users get the new default-on behavior with no way to tune or disable it

### Simplify when defaults add no value
- If `None` just means a default value, consider using a plain type instead
- *Example:* `start_index: u64` with default 0 is simpler than `Option<u64>` where `None` means 0

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

### Pass functions point-free when the lambda only forwards arguments
- A callback that does nothing but forward its single argument is redundant wrapping; pass the function directly
- *Example:* `values.map(toBigInt)` instead of `values.map((value) => toBigInt(value))`
- *Caveat:* Only safe when the function ignores the extra arguments `Array.map`/`forEach`/etc. pass (`element, index, array`). A function that reads a second parameter breaks — e.g. `["1","2"].map(parseInt)` feeds the index in as the radix and returns `[1, NaN]`. When in doubt, keep the explicit arrow

### Check for existing utilities before adding new ones
- Before writing a local helper function, search the codebase for existing shared utilities
- If similar code exists in multiple places, extract to a shared module (e.g., `test_fixtures.rs` for test helpers)
- *Example:* Test helpers like `get_channel_key()` belong in `test_fixtures.rs`, not duplicated in each test module

---

## Comments

### Explain WHY, not WHAT
- Add comments where the reasoning isn't obvious from context
- Focus on decisions, constraints, and non-obvious requirements

### No visual separator comments
- Don't use decorative comment lines to delineate sections (e.g., `// -----------`, `// =========`, `// ***`)
- If a file needs visual structure, that's a signal to split into separate modules or use doc comments on items
- Rely on blank lines and module organization for readability, not ASCII art

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

## Module Organization

### Public entry points first
- Place public functions at the top of the module, before their private helpers
- Readers should encounter the high-level orchestration first and drill into details top-down
- *Example:* `pub async fn sync_incoming_state(...)` at the top, followed by `process_channel(...)`, then `process_subchannel(...)`

### Imports at scope top, not inline
- Place `use` statements at the top of the scope they serve — module-level for module-wide usage, `#[cfg(test)] mod tests` top for test-only usage
- Never put `use` inside function bodies; hoist to the enclosing module
- Use short imported names in signatures and bodies, not inline qualified paths like `super::types::Foo` or `crate::module::Bar`
- *Bad:* `fn f(key: &super::types::SecretFelt)` with no import; `use crate::Foo;` inside a function body
- *Good:* `use super::types::SecretFelt;` at module top, then `fn f(key: &SecretFelt)`
