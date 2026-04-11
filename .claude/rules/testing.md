**MANDATORY:** Always add unit and/or integration tests for any code change unless clearly not applicable (e.g., documentation, interface definitions without implementation body).

**NEVER** ignore or skip tests:
- No `#[ignore]` attributes in Rust
- No `.skip()` in JavaScript/TypeScript
- If a test is failing, fix the root cause - don't hide it

**No "pre-existing" failures:**
- There is no such thing as a pre-existing failure. If tests fail, investigate and fix before claiming done.
- Never dismiss a failure as "unrelated to our changes" without proving it.
- The task is not complete until all tests pass with 0 failures.

**Workaround for unrelated-looking test failures:**
- If tests fail in ways that seem unrelated to current changes, first try a clean reinstall: delete `node_modules/` and lock files in `sdk/` and `e2e/`, then `npm install` fresh. Dependency drift and stale caches cause phantom failures.

**Test quality requirements:**
- Tests must be meaningful - `assert_ne` or trivial assertions give false coverage impression
- Use reference vectors when available in the codebase; if none exist, ask user to provide them or instructions to generate them
- Think about edge cases: empty inputs, boundary values, error conditions
- Always assume the worst - test failure modes, not just happy paths
