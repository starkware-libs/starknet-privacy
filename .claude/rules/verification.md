**MANDATORY:** Before claiming work is complete, fixed, or passing, invoke `/verification-before-completion`. Run fresh verification commands and confirm output before making any success claims. Evidence before assertions, always.

**Cairo verification checklist:**
- If `snforge` is not in PATH, read `.tool-versions` for the version and use `~/.asdf/installs/starknet-foundry/<version>/bin/snforge`
- `snforge test` - all tests pass

**Rust verification checklist:**
- `cargo fmt --check` - code formatting
- `cargo clippy` - lints (0 warnings required), including integration tests, for all targets
- `cargo test` - all tests pass, for all targets

**SDK verification checklist (from `sdk/`):**
- `npm run lint` - formatting (prettier), lints (eslint), and type-check (tsc) in one command
- If lint fails on formatting or auto-fixable eslint issues, run `npm run format` to fix them

## E2E integration gate

After finalizing any change to Rust crates or the TypeScript SDK, propose running E2E tests to the user. Before running them:
1. Rebuild affected Rust binaries: `cargo build -p <crate>` (E2E spawns binaries from `target/debug/`)
2. Rebuild the SDK: `cd sdk && npm run build` (E2E resolves `starknet-sdk` from built `.d.ts`/`.js`, not source)
3. Run E2E: `cd e2e && npm test`

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

## E2E scripts verification checklist (from repo root)

- `npx prettier --check e2e/scripts/` - code formatting
- `cd e2e && npx eslint scripts/` - lints (0 warnings required)
- Do **not** run `tsc --noEmit` in `e2e/` — pre-existing type gaps in scripts cause false failures

## E2E tests

E2E tests (`cd e2e && npm test`) are slow. Run them only once per finalized changeset, not after each incremental edit.
