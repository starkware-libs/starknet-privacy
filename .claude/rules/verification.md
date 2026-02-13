**MANDATORY:** Before claiming work is complete, fixed, or passing, invoke `/verification-before-completion`. Run fresh verification commands and confirm output before making any success claims. Evidence before assertions, always.

**Rust verification checklist:**
- `cargo fmt --check` - code formatting
- `cargo clippy` - lints (0 warnings required), including integration tests, for all targets
- `cargo test` - all tests pass, for all targets

**TypeScript verification checklist:**
- `cd sdk && npm run format:check` - prettier formatting
- `cd sdk && npm run lint:check` - eslint lints
- `cd sdk && npm run build` - compiles
- `cd sdk && npm run test:fast` - tests pass (excludes devnet/parallel-discovery)

## Cross-layer consistency

When changing Rust code, always check whether the change must be reflected in other layers:
- **TypeScript SDK** (`sdk/`): API contracts, request/response shapes, service semantics
- **E2E tests** (`e2e/`): CLI args, config, spawn logic, test assertions

Propagate changes to affected layers before claiming done.

## Post-verification simplification

After all verification passes (fmt, clippy, tests), ask the user if they want to explore code simplifications on the changed files. If yes:
1. Take user input (they may have specific suggestions or areas of concern)
2. Enter plan mode
3. Invoke `/code-simplifier:code-simplifier` on recently modified files
4. Present the simplification plan to the user for review
5. Iterate with the user until the plan is settled
6. Execute the agreed simplifications
7. Re-run verification to confirm nothing broke

## E2E tests

E2E tests (`cd e2e && npm test`) are slow. Run them only once, at the very end, after all edits across all layers are complete. Do not run them after each incremental change.
