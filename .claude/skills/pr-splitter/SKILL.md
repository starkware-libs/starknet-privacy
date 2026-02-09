---
name: pr-splitter
description: >
  Split a large work-in-progress PR into a stack of small, reviewable PRs.
  Use this skill whenever the user mentions splitting a PR, stacking PRs,
  breaking up a large diff, making a PR easier to review, creating a PR stack,
  or decomposing changes into incremental commits. Also trigger when the user
  says things like "this PR is too big", "reviewers are struggling with this",
  or "I need to break this into smaller pieces". Works with any git-based
  project and any language.
---

# PR Splitter

Split a large WIP PR into a stack of small, self-contained, reviewable PRs.

## Philosophy

You are a *curator*, not a *refactorer*. The user worked fast — deep refactors,
renames, breaking changes — and now needs it reviewable. Faithfully reproduce
subsets of the existing diff as incremental slices.

- **Copy changes exactly as they are.** Never rewrite, restyle, or improve logic.
- Each slice must compile/build on its own (or at least not break the build).
- Each slice should be a coherent unit a reviewer can understand in isolation.
- Target **100–200 lines of meaningful code** per slice (exclude tests, comments, blanks).
- Always include related tests with the code they test — never ship untested features.
- Order slices by module dependency: foundational changes first, consumers later.

## Utilities Over Prompting

Use shell commands for all mechanical work. Do not read file contents into context
or reason about diffs in prose when a utility can produce the answer directly.

| Task | Use | Don't |
|------|-----|-------|
| Copy files | `cp` from worktree | Regenerate file content |
| Compare files | `diff -q`, `diff -u` | Read both files and reason about differences |
| Find what changed | `git diff --stat`, `git diff --name-only` | Parse diff output mentally |
| Extract one file's diff | `awk` on the saved full diff | Read entire diff into context |
| Check file coverage | `comm` on sorted file lists | Manually cross-check lists |
| Count LOC | `grep`/`wc` pipelines on diff output | Count lines by reading them |
| Apply partial changes | `git apply --3way` on extracted patch | Manually re-type code |
| Match branch to slice | `grep` the plan file | Re-read entire plan |
| Track progress | `diff -rq` against worktree | Ask the user what's done |

Only use LLM reasoning for: understanding semantics, planning slice groupings,
resolving ambiguous dependencies, and communicating with the user.

Read `utility-patterns.md` for copy-paste command recipes for every phase.

## Workflow Overview

```
1. Init workspace: fetch diff, create worktree, generate manifests
2. Analyze: dependency graph + semantics (grep for imports, LLM for interpretation)
3. Plan slices, build file accounting, verify coverage with comm
4. Write .claude/pr-split-plan.md, iterate with user
5. Per slice:
   a. Orient: grep plan for current branch, determine slice number
   b. Write slice file list (.claude/slices/slice-N.tsv)
   c. Apply: cp/rm/git-apply per strategy
   d. Verify: diff each file against worktree
   e. Update plan, check remaining with diff -rq
6. Final: diff -rq working tree against worktree — should be empty
7. Cleanup: git worktree remove
```

## Detailed Procedure

### Phase 1: Initialize Workspace

When the user shares a PR link, extract the PR number and run:

```bash
mkdir -p .claude

# Fetch metadata — save as structured JSON for later jq queries
gh pr view <PR> --json baseRefName,headRefName,title,url,additions,deletions,number \
    > .claude/workspace-meta.json

# Fetch and save the full diff — source of truth for the entire process
gh pr diff <PR> > .claude/pr-full.diff

# File manifest with change types (A/M/D/R)
git fetch origin $(jq -r .baseRefName .claude/workspace-meta.json) \
                  $(jq -r .headRefName .claude/workspace-meta.json) --quiet
BASE=origin/$(jq -r .baseRefName .claude/workspace-meta.json)
HEAD=origin/$(jq -r .headRefName .claude/workspace-meta.json)
git diff --name-status "$BASE"..."$HEAD" > .claude/pr-files.tsv

# Per-file line counts for sizing estimates
git diff --numstat "$BASE"..."$HEAD" > .claude/pr-numstat.tsv

# Reference worktree — read-only copy of every file at PR head state
PR_HEAD_SHA=$(git rev-parse "$HEAD")
jq --arg sha "$PR_HEAD_SHA" '. + {head_sha: $sha}' .claude/workspace-meta.json \
    > .claude/workspace-meta.tmp && mv .claude/workspace-meta.tmp .claude/workspace-meta.json
git worktree add .claude/pr-head-worktree "$PR_HEAD_SHA" --detach --quiet
```

If `gh` is not available:
```bash
git fetch origin pull/<PR>/head:pr-head
BASE=origin/<base-branch>
HEAD=pr-head
# then same commands as above
```

Suggest adding `.claude/` to `.gitignore` or `.git/info/exclude`.

**Artifacts created:**
- `.claude/workspace-meta.json` — PR metadata, head SHA
- `.claude/pr-full.diff` — complete diff
- `.claude/pr-files.tsv` — `<change_type>\t<path>` per changed file
- `.claude/pr-numstat.tsv` — `<add>\t<del>\t<path>` per file
- `.claude/pr-head-worktree/` — detached worktree at PR head

### Phase 2: Build the Dependency Graph

Extract import relationships mechanically, then interpret with LLM reasoning.

```bash
# Rust: find crate-internal imports in changed files
awk -F'\t' '{print $2}' .claude/pr-files.tsv | while read f; do
    [ -f ".claude/pr-head-worktree/$f" ] || continue
    imports=$(grep -cE '^use (crate|super|self)::' ".claude/pr-head-worktree/$f" 2>/dev/null || echo 0)
    [ "$imports" -gt 0 ] && echo "$f ($imports imports)" && \
        grep -nE '^use (crate|super|self)::' ".claude/pr-head-worktree/$f"
done

# TypeScript: find relative imports
awk -F'\t' '$2 ~ /\.(ts|tsx)$/ {print $2}' .claude/pr-files.tsv | while read f; do
    [ -f ".claude/pr-head-worktree/$f" ] || continue
    grep -nE "from ['\"]\.\.?/" ".claude/pr-head-worktree/$f" || true
done
```

Read `dependency-analysis.md` for more language patterns.

Use LLM to interpret the graph: identify roots (depended on by many), leaves
(no internal deps), tightly coupled clusters.

### Phase 3: Semantic Analysis

Read files from the worktree to understand roles:
```bash
# Overview: file types and change sizes
sort -t$'\t' -k1,1 -k3,3 .claude/pr-numstat.tsv

# Read specific file from PR head
cat .claude/pr-head-worktree/src/some_file.rs

# See a specific file's diff
awk '/^diff --git a\/src\/some_file.rs b\/src\/some_file.rs$/,/^diff --git /' \
    .claude/pr-full.diff | sed '$ d'
```

LLM reasoning is appropriate here: what each change does, which changes are
coupled, how to group coherently.

### Phase 4: Plan the Slices

Rules in priority order:
1. **Compilability**: no unresolvable references within a slice.
2. **Test coverage**: features ship with their tests.
3. **Coherence**: each slice tells a clear story to a reviewer.
4. **Size**: target 100–200 LOC. Estimate with numstat:
   ```bash
   awk -F'\t' '$3 ~ /types.rs|config.rs/ {sum += $1 + $2} END {print sum " LOC"}' \
       .claude/pr-numstat.tsv
   ```
5. **Dependency order**: topological sort — foundations first.

See SKILL.md section "Handling Common Patterns" in earlier versions, patterns
still apply: renames with call-sites, type changes with consumers, new modules
with tests, deletions with replacements, config in slice 1.

### Phase 5: File Accounting

Create `.claude/accounting.tsv`:
```
# path	slice(s)
src/types.rs	1
src/handler.rs	2,4
src/new_module.rs	3
tests/test_handler.rs	4
old_module.rs	2
```

Verify 100% coverage using set operations:
```bash
# PR files (sorted, paths only)
awk -F'\t' '{print $NF}' .claude/pr-files.tsv | sort > /tmp/pr-files-sorted.txt

# Accounted files (sorted, unique paths)
awk -F'\t' '!/^#/ && NF>=2 {print $1}' .claude/accounting.tsv | sort -u > /tmp/accounted-sorted.txt

# Files in PR but not accounted for (must be empty)
comm -23 /tmp/pr-files-sorted.txt /tmp/accounted-sorted.txt

# Files accounted but not in PR (possible typos)
comm -13 /tmp/pr-files-sorted.txt /tmp/accounted-sorted.txt
```

Both `comm` outputs must be empty before proceeding.

### Phase 6: Write the Plan and Iterate

Create `.claude/pr-split-plan.md` per `plan-format.md`. Include:
- Branch Map with suggested names: `pr-split/01-<short-name>`, `pr-split/02-...`
- Per-slice file lists with strategies
- File accounting table

Present to user, iterate until approved.

### Phase 7: Extract Slices (One at a Time, Stacked)

Slices form a stack. The user manages branches (Graphite, git, etc.).
Claude never creates branches, commits, or pushes.

#### 7a. Orient

Determine where you are:
```bash
BRANCH=$(git branch --show-current)
echo "On: $BRANCH"

# Match branch to slice in plan
grep -n "$BRANCH" .claude/pr-split-plan.md || true

# Or find by slice number if branch name contains it
# e.g., pr-split/03-api → slice 3

# Quick progress count
grep -c 'Status.*done' .claude/pr-split-plan.md || echo "0 done"
grep -c 'Status.*pending' .claude/pr-split-plan.md || echo "0 pending"

# Worktree health
[ -d .claude/pr-head-worktree ] && echo "Worktree: OK" || echo "Worktree: MISSING"
```

If the worktree is missing:
```bash
git worktree add .claude/pr-head-worktree $(jq -r .head_sha .claude/workspace-meta.json) --detach
```

Record the actual branch name in the plan if it differs from the suggestion.

#### 7b. Write the slice file list

Create `.claude/slices/slice-N.tsv`:
```
# strategy	path	[old_path]
copy	src/types.rs
copy	src/types_test.rs
delete	src/old_config.rs
rename	src/new_name.rs	src/old_name.rs
patch	src/handler.rs
```

Strategies:
- `copy` — file fully handled by this slice (or last slice touching it). `cp` from worktree.
- `delete` — `git rm`
- `rename` — `cp` new from worktree + `git rm` old
- `patch` — file split across slices; selective hunk application needed

#### 7c. Apply the slice

Process the file list mechanically:
```bash
WT=.claude/pr-head-worktree

# Apply all 'copy' entries
awk -F'\t' '$1 == "copy" {print $2}' .claude/slices/slice-N.tsv | while read f; do
    mkdir -p "$(dirname "$f")"
    cp "$WT/$f" "$f"
    git add "$f"
done

# Apply all 'delete' entries
awk -F'\t' '$1 == "delete" {print $2}' .claude/slices/slice-N.tsv | while read f; do
    git rm -q "$f"
done

# Apply all 'rename' entries
awk -F'\t' '$1 == "rename" {print $2 "\t" $3}' .claude/slices/slice-N.tsv | while IFS=$'\t' read new old; do
    mkdir -p "$(dirname "$new")"
    cp "$WT/$new" "$new"
    git add "$new"
    git rm -q "$old" 2>/dev/null || true
done
```

#### 7d. Handle patch-strategy files

For files split across slices — read `partial-file-changes.md`.

Quick version:
```bash
# Extract one file's diff from the saved full diff
awk '/^diff --git a\/src\/handler.rs b\/src\/handler.rs$/,/^diff --git /' \
    .claude/pr-full.diff | sed '$ d' > /tmp/handler.patch

# See the hunks
grep '^@@' /tmp/handler.patch

# Apply all hunks (if all belong to this slice)
git apply --3way /tmp/handler.patch

# Or filter to specific hunks first (by hunk number, 1-indexed)
awk '/^@@/{n++} n==0||n==1||n==3' /tmp/handler.patch > /tmp/handler-partial.patch
git apply --3way /tmp/handler-partial.patch

git add src/handler.rs
```

#### 7e. Verify

```bash
# Files changed in this slice
git diff --name-only HEAD

# Per-file comparison against worktree
git diff --name-only HEAD | while read f; do
    if diff -q "$f" .claude/pr-head-worktree/"$f" 2>/dev/null; then
        echo "✅ $f"          # exact match — this file is at final state
    else
        echo "⚠️  $f (delta remains — OK if later slices touch it)"
        diff "$f" .claude/pr-head-worktree/"$f" | head -5
    fi
done

# File list cross-check: actual changes match planned files
PLANNED=$(awk -F'\t' '!/^#/ {print $2}' .claude/slices/slice-N.tsv | sort)
ACTUAL=$(git diff --name-only HEAD | sort)
comm -3 <(echo "$PLANNED") <(echo "$ACTUAL")
# Both columns should be empty

# Meaningful LOC (rough)
git diff HEAD -- ':(exclude)*test*' ':(exclude)*/tests/*' \
    | grep -c '^[+-]' | head -1
```

If anything fails, fix before reporting to user.

#### 7f. Report to user

Brief: files applied, verification result, any warnings. Suggest a commit message.

#### 7g. Update plan and track progress

Mark slice done in `.claude/pr-split-plan.md`. Update Branch Map actual column.

Track remaining work:
```bash
# Count PR files that now match worktree vs those that don't
awk -F'\t' '{print $NF}' .claude/pr-files.tsv | while read f; do
    [ -f "$f" ] && [ -f ".claude/pr-head-worktree/$f" ] && \
        diff -q "$f" ".claude/pr-head-worktree/$f" > /dev/null 2>&1 && \
        echo "done" || echo "remaining"
done | sort | uniq -c
```

### Phase 8: Final Completeness Verification

After last slice, on the final stacked branch:
```bash
# Compare every PR-changed file against worktree
awk -F'\t' '{print $NF}' .claude/pr-files.tsv | while read f; do
    wt=".claude/pr-head-worktree/$f"
    if [ -f "$f" ] && [ -f "$wt" ]; then
        diff -q "$f" "$wt" > /dev/null 2>&1 && echo "✅ $f" || echo "❌ $f"
    elif [ ! -f "$f" ] && [ ! -f "$wt" ]; then
        echo "✅ $f (deleted)"
    else
        echo "❌ $f (existence mismatch)"
    fi
done

# Quick summary
awk -F'\t' '{print $NF}' .claude/pr-files.tsv | while read f; do
    wt=".claude/pr-head-worktree/$f"
    if [ -f "$f" ] && [ -f "$wt" ] && diff -q "$f" "$wt" > /dev/null 2>&1; then
        echo pass
    elif [ ! -f "$f" ] && [ ! -f "$wt" ]; then
        echo pass
    else
        echo fail
    fi
done | sort | uniq -c
```

Expected: all pass, zero fail. Record in plan under `## Final Verification`.

### Phase 9: Cleanup

```bash
git worktree remove .claude/pr-head-worktree
```

Keep `.claude/pr-split-plan.md` as documentation.

### Phase 10: Navigation & Memory

**At the start of every new turn**, orient:
```bash
echo "Branch: $(git branch --show-current)"
grep -n "$(git branch --show-current)" .claude/pr-split-plan.md 2>/dev/null || echo "Branch not in plan"
grep -c 'Status.*done' .claude/pr-split-plan.md 2>/dev/null || echo "0 done"
grep -c 'Status.*pending' .claude/pr-split-plan.md 2>/dev/null || echo "0 pending"
[ -d .claude/pr-head-worktree ] && echo "Worktree: OK" || echo "Worktree: MISSING"
```

If worktree is missing:
```bash
git worktree add .claude/pr-head-worktree $(jq -r .head_sha .claude/workspace-meta.json) --detach
```

Then read `.claude/pr-split-plan.md` for detailed context.

### Branch Naming

When writing the plan, suggest branch names: `pr-split/01-<short-name>`,
`pr-split/02-<short-name>`, etc. Zero-padded so `git branch` output reads
like a table of contents. The user may use different names (Graphite, etc.) —
record actual names in the plan's Branch Map when branches are created.

## Important Constraints

- **Never modify logic.** Extracting exact subsets of an existing diff.
- **Never commit or push.** Only prepare staged changes.
- **Never create or switch branches.** The user handles branching.
- **Use utilities for mechanical work.** `cp`, `diff`, `awk`, `comm`, `grep`, `git apply`.
  Don't read diffs into context to reason about them in prose.
- **Always verify with diff.** Every slice gets per-file `diff -q` against worktree.
- **Keep the plan updated.** Source of truth for multi-turn work.
- **Account for every file.** `comm` on sorted lists must show zero unaccounted.
- **Verify completeness at the end.** All PR files must match worktree.
- **Manage the worktree.** Recreate from stored SHA if missing. Clean up when done.
- **Gitignore .claude/.** Suggest adding to `.gitignore` or `.git/info/exclude`.
- **Ask before proceeding** if a slice can't be cleanly extracted.

## Reference Files

- `dependency-analysis.md` — Language-specific import extraction patterns
- `plan-format.md` — Template for `.claude/pr-split-plan.md`
- `partial-file-changes.md` — Handling files split across multiple slices
- `utility-patterns.md` — Command recipes for every mechanical operation
