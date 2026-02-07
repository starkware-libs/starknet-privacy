**MANDATORY:** Before claiming work is complete, fixed, or passing, invoke `/verification-before-completion`. Run fresh verification commands and confirm output before making any success claims. Evidence before assertions, always.

**Rust verification checklist:**
- `cargo fmt --check` - code formatting
- `cargo clippy` - lints (0 warnings required), including integration tests (all targets)
- `cargo test` - all tests pass

## Cross-layer consistency

When changing Rust code, always check whether the change must be reflected in other layers:
- **TypeScript SDK** (`sdk/`): API contracts, request/response shapes, service semantics
- **E2E tests** (`e2e/`): CLI args, config, spawn logic, test assertions

Propagate changes to affected layers before claiming done.

## E2E tests

E2E tests (`cd e2e && npm test`) are slow. Run them only once, at the very end, after all edits across all layers are complete. Do not run them after each incremental change.
