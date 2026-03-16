# Plan Format

The plan file lives at `.claude/pr-split-plan.md` and is the persistent state
across conversation turns. Always read it at the start of a new turn.

## Template

```markdown
# PR Split Plan

**PR**: <title> — <url>
**PR Number**: <number>
**Base branch**: <base>
**Head branch/ref**: <head>
**Head SHA**: <full sha>
**Reference worktree**: .claude/pr-head-worktree
**Total files changed**: <N>
**Total lines changed**: +<additions> / -<deletions>
**Saved diff**: .claude/pr-full.diff
**Generated**: <timestamp>
**Last updated**: <timestamp>
**Status**: planning | approved | in-progress | complete

## Summary

<1-2 sentences describing the overall PR and the splitting strategy>

## Branch Map

Suggested naming convention: `pr-split/NN-<short-name>` (zero-padded slice number).
The user may use different names (e.g., Graphite's auto-naming). Record actual names
once branches are created.

| Slice | Suggested Branch | Actual Branch | Status |
|-------|-----------------|---------------|--------|
| 1 | `pr-split/01-<short-name>` | | pending |
| 2 | `pr-split/02-<short-name>` | | pending |
| ... | | | |

## Dependency Graph Notes

<Brief description of the key dependency relationships that informed slice ordering.
Which modules are foundational? Which are leaf consumers?>

## File Accounting

Every changed file in the PR must appear in this table exactly once (or appear
in multiple rows if split across slices, with hunk descriptions).

| File | Change Type | Slice(s) | Strategy | Notes |
|------|-------------|----------|----------|-------|
| `src/types.rs` | modified | 1 | full checkout | foundational types |
| `src/handler.rs` | modified | 2, 4 | SPLIT | auth hunks → 2, API hunks → 4 |
| `src/new_module.rs` | added | 3 | full checkout | new feature |
| `tests/test_handler.rs` | modified | 4 | full checkout | tests for handler API |
| `old_module.rs` | deleted | 2 | git rm | replaced by new_module |

**Unaccounted files**: 0 (must be zero before proceeding)

## Slices

### Slice 1: <descriptive-title>
- **Status**: pending | in-progress | done
- **Branch (suggested)**: `pr-split/01-<short-name>`
- **Branch (actual)**: <filled when user creates it>
- **Estimated LOC**: <N> (excluding tests/comments/blanks)
- **Description**: <What this slice does and why it's self-contained>
- **Files**:
  - `path/to/file1.rs` (modified) — full checkout
  - `path/to/file2.rs` (added) — full checkout
  - `path/to/file1_test.rs` (modified) — full checkout
- **Depends on**: — (none, this is foundational)
- **Verification**: pending

### Slice 2: <descriptive-title>
- **Status**: pending
- **Branch (suggested)**: `pr-split/02-<short-name>`
- **Branch (actual)**: <filled when user creates it>
- **Estimated LOC**: <N>
- **Description**: <...>
- **Files**:
  - `path/to/file3.rs` (modified) — full checkout
  - `path/to/handler.rs` (modified) — SPLIT: auth-related hunks only
- **Depends on**: Slice 1
- **Verification**: pending

... (continue for all slices)

## Issues & Notes

<Running log of problems, decisions, or deviations. Append with timestamps.>

- <timestamp>: <note>

## Progress

- [x] Phase 1: Diff fetched and saved
- [x] Phase 2: Dependency graph built
- [x] Phase 3: Semantic analysis complete
- [x] Phase 4: Slices planned
- [x] Phase 5: File accounting verified (0 unaccounted)
- [x] Phase 6: Plan approved by user
- [ ] Slice 1: <title>
- [ ] Slice 2: <title>
- ...
- [ ] Final completeness verification

## Final Verification

<Filled in after all slices are done>

**Command**: `diff -rq . .claude/pr-head-worktree/ --exclude=.git --exclude=.claude`
**Result**: <empty | N lines differ>
**Acceptable**: <yes/no>
**Details**: <if differences exist, list them>
```

## Update Rules

- When the user creates a branch for a slice, record the **actual branch name**
  in both the Branch Map table and the per-slice `Branch (actual)` field.
- Mark a slice as `in-progress` when you start extracting it.
- Mark a slice as `done` only after `verify-slice.sh` passes.
- Add notes to the Issues section when anything unexpected happens.
- If the plan needs to change (merge slices, reorder, add new ones), update
  the plan file first, explain the change in Issues, then proceed.
- Always update the Progress checklist to reflect current state.
- After the last slice, fill in the Final Verification section.

## Reading the Plan

At the start of each turn:
1. Read `.claude/pr-split-plan.md`
2. Find the current status — which slice is next?
3. Check Issues for any context from previous turns
4. Verify the reference worktree exists at the path in the plan header.
   If missing, recreate it: `git worktree add <path> <Head SHA> --detach`
5. Note the PR URL and head SHA in case you need to re-fetch anything
6. Continue from where you left off
