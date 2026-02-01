# Claude Code Instructions

## Prohibited

**NEVER** perform any git or graphite commands that modify repository state:
- No commits (add, commit, amend)
- No pushing or pulling
- No rebasing, merging, cherry-picking
- No branch creation/deletion

**Allowed:** Read-only commands for context retrieval and debugging (status, log, diff, show, blame, etc.)

## Planning

Keep the scope for the current task small enough to target ~100 lines of code (excluding comments, tests, line spacing, etc). If a task would exceed this, suggest reducing the scope. User makes the final decision if it's not sensible to reduce the atomic changeset.

Reviewer time is expensive:
- Avoid refactoring follow-ups if it's clear changes would be required - do it right the first time
- Avoid non-intuitive solutions; if unavoidable, compensate with comprehensive "why" documentation
- We operate with large PR stacks, each a small atomic change. If a necessary refactoring is identified somewhere in the stack, suggest incorporating it early in the stack to reduce overall reviewing effort

## Debugging

**MANDATORY:** When encountering any bug, test failure, or unexpected behavior, invoke `/debugging-wizard` BEFORE proposing fixes. No exceptions.

## Verification

**MANDATORY:** Before claiming work is complete, fixed, or passing, invoke `/verification-before-completion`. Run fresh verification commands and confirm output before making any success claims. Evidence before assertions, always.

## Code Review

**MANDATORY:** When addressing GitHub PR comments or terminal review followups, invoke `/receiving-code-review` BEFORE making changes. No exceptions.

## PR Review

**MANDATORY:** When reviewing someone else's PR, invoke `/code-reviewer` BEFORE providing feedback.

**Review quality requirements:**
- For each change, provide concise context: "what" it does and "why" it's needed
- Analyze based on the codebase state at the commit prior to the PR, not just the diff
- Consider how the change fits into the existing architecture and patterns

## Testing

**MANDATORY:** Always add unit and/or integration tests for any code change unless clearly not applicable (e.g., documentation, interface definitions without implementation body).

**Test quality requirements:**
- Tests must be meaningful - `assert_ne` or trivial assertions give false coverage impression
- Use reference vectors when available in the codebase; if none exist, ask user to provide them or instructions to generate them
- Think about edge cases: empty inputs, boundary values, error conditions
- Always assume the worst - test failure modes, not just happy paths

## Specs

Discovery service specs live in `.claude/specs/discovery-service/`.

The **source of truth** for privacy pool contract interface and semantics (encryption, hashing, etc.) is the Cairo code.

When planning discovery-core or discovery-service changes:
1. Always check against the Cairo code and/or service specs
2. If any divergence between existing code and spec:
   - Prompt for changing the code (if the spec is right), OR
   - Update the stale spec (if the code is right)
3. After a change is implemented and verified, always update/extend the spec if necessary (choose the appropriate document in the folder)

## Auto-update Code Guidelines

When receiving feedback from the user or PR reviewers about code quality, style, or best practices:

1. Implement the requested fix
2. **Generalize the lesson** and update `.claude/commands/code-guidelines.md`:
   - Extract the underlying principle, not the specific fix
   - Frame past fixups as illustrative examples, not as the rule itself
   - Add under the appropriate section (Naming, Documentation, Edge Cases, Comments, Testing)
   - If no section fits, create a new one or add to the WIP section

This ensures lessons from code reviews accumulate as reusable principles, not a changelog of past issues.
