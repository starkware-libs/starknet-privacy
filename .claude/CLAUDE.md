# Claude Code Instructions

## Prohibited

**NEVER** perform any git or graphite commands that modify repository state, unless the user explicitly asks for the specific action in the current turn:
- No commits (add, commit, amend)
- No pushing or pulling
- No rebasing, merging, cherry-picking
- No branch creation/deletion

**Exception — opening pull requests:** Allowed *only* when the user explicitly asks for it (e.g., "open a PR", "create a PR"). A general approval to act autonomously does not count; the request must be specific to this action. Even when allowed, do not push to `main`/`master` and do not force-push.

**Allowed:** Read-only commands for context retrieval and debugging (status, log, diff, show, blame, etc.)

## Planning

Keep the scope for the current task small enough to target ~100-200 lines of code (excluding comments, tests, line spacing, etc) unless explicitly stated otherwise. If a task would exceed this, suggest reducing the scope. User makes the final decision if it's not sensible to reduce the atomic changeset.

## Specs

Discovery service specs live in `crates/discovery-service/specs/`.

The **source of truth** for privacy pool contract interface and semantics (encryption, hashing, etc.) is the Cairo code.

**When planning** discovery-core or discovery-service changes:
1. Always check against the Cairo code and service specs
2. If any divergence between existing code and spec:
   - Prompt for changing the code (if the spec is right), OR
   - Update the stale spec (if the code is right)

**MUST after verification** of discovery-core or discovery-service changes:
- Review relevant specs and update if the implementation changed any documented behavior
- Specs must stay in sync with verified code - no exceptions
