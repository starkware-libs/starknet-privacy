**MANDATORY:** Always add unit and/or integration tests for any code change unless clearly not applicable (e.g., documentation, interface definitions without implementation body).

**NEVER** ignore or skip tests:
- No `#[ignore]` attributes in Rust
- No `.skip()` in JavaScript/TypeScript
- If a test is failing, fix the root cause - don't hide it

**Test quality requirements:**
- Tests must be meaningful - `assert_ne` or trivial assertions give false coverage impression
- Use reference vectors when available in the codebase; if none exist, ask user to provide them or instructions to generate them
- Think about edge cases: empty inputs, boundary values, error conditions
- Always assume the worst - test failure modes, not just happy paths
