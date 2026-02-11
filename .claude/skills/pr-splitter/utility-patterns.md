# Utility Patterns

Command recipes for every mechanical operation in the PR split workflow.
Copy and adapt these — don't reinvent. Variables `$WT`, `$BASE`, `$HEAD` refer
to `.claude/pr-head-worktree`, base branch, head branch respectively.

## File Manifest Queries

```bash
# List all changed files
cat .claude/pr-files.tsv

# Count changed files
wc -l < .claude/pr-files.tsv

# Only added files
awk -F'\t' '$1 == "A"' .claude/pr-files.tsv

# Only modified files
awk -F'\t' '$1 == "M"' .claude/pr-files.tsv

# Only deleted files
awk -F'\t' '$1 == "D"' .claude/pr-files.tsv

# Renamed files (shows old→new)
awk -F'\t' '$1 ~ /^R/' .claude/pr-files.tsv

# Files matching a pattern (e.g., Rust source)
awk -F'\t' '$NF ~ /\.rs$/' .claude/pr-files.tsv

# Largest changes (by total lines)
awk -F'\t' '{print $1+$2, $3}' .claude/pr-numstat.tsv | sort -rn | head -20
```

## Extracting Diffs

```bash
# Full diff for one file
awk '/^diff --git a\/PATH b\/PATH$/,/^diff --git /' \
    .claude/pr-full.diff | head -n -1

# Hunk headers only (to see structure)
awk '/^diff --git a\/PATH b\/PATH$/,/^diff --git /' \
    .claude/pr-full.diff | grep '^@@'

# Specific hunks by number (1-indexed, keeps diff header)
awk '/^diff --git a\/PATH b\/PATH$/,/^diff --git /' \
    .claude/pr-full.diff | head -n -1 | \
    awk '/^@@/{n++} n==0 || n==1 || n==3'
```

Replace `PATH` with the actual file path (forward slashes, no leading `/`).

## File Copy Operations

```bash
WT=.claude/pr-head-worktree

# Copy single file
mkdir -p "$(dirname "path/to/file")"
cp "$WT/path/to/file" "path/to/file"
git add "path/to/file"

# Copy list of files from TSV
awk -F'\t' '$1 == "copy" {print $2}' .claude/slices/slice-N.tsv | while read f; do
    mkdir -p "$(dirname "$f")"
    cp "$WT/$f" "$f"
    git add "$f"
done

# Delete files from TSV
awk -F'\t' '$1 == "delete" {print $2}' .claude/slices/slice-N.tsv | while read f; do
    git rm -q "$f"
done

# Rename files from TSV (col3=old_path)
awk -F'\t' '$1 == "rename"' .claude/slices/slice-N.tsv | while IFS=$'\t' read _ new old; do
    mkdir -p "$(dirname "$new")"
    cp "$WT/$new" "$new"
    git add "$new"
    git rm -q "$old" 2>/dev/null || true
done
```

## Verification

```bash
WT=.claude/pr-head-worktree

# Per-file exact match check
git diff --name-only HEAD | while read f; do
    if diff -q "$f" "$WT/$f" 2>/dev/null; then
        echo "✅ $f"
    else
        echo "⚠️  $f"
    fi
done

# Cross-check planned vs actual changed files
PLANNED=$(awk -F'\t' '!/^#/ {print $2}' .claude/slices/slice-N.tsv | sort)
ACTUAL=$(git diff --name-only HEAD | sort)
echo "--- Missing (planned but not changed) ---"
comm -23 <(echo "$PLANNED") <(echo "$ACTUAL")
echo "--- Extra (changed but not planned) ---"
comm -13 <(echo "$PLANNED") <(echo "$ACTUAL")

# Meaningful LOC (rough count, excluding test files)
git diff HEAD -- ':(exclude)*test*' ':(exclude)*/tests/*' \
    | grep '^[+-]' | grep -v '^[+-][+-][+-]' | grep -v '^[+-]\s*$' \
    | grep -v '^[+-]\s*//' | grep -v '^[+-]\s*#' | wc -l
```

## File Accounting

```bash
# Check that every PR file is assigned to a slice
awk -F'\t' '{print $NF}' .claude/pr-files.tsv | sort > /tmp/pr.txt
awk -F'\t' '!/^#/ {print $1}' .claude/accounting.tsv | sort -u > /tmp/acct.txt

echo "Unaccounted:"
comm -23 /tmp/pr.txt /tmp/acct.txt

echo "Not in PR (typos?):"
comm -13 /tmp/pr.txt /tmp/acct.txt
```

## Progress Tracking

```bash
WT=.claude/pr-head-worktree

# Count files matching worktree (done) vs not (remaining)
awk -F'\t' '{print $NF}' .claude/pr-files.tsv | while read f; do
    if [ -f "$f" ] && [ -f "$WT/$f" ] && diff -q "$f" "$WT/$f" > /dev/null 2>&1; then
        echo done
    elif [ ! -f "$f" ] && [ ! -f "$WT/$f" ]; then
        echo done  # both deleted
    else
        echo remaining
    fi
done | sort | uniq -c

# Slice progress from plan
echo "Done:    $(grep -c 'Status.*done' .claude/pr-split-plan.md 2>/dev/null || echo 0)"
echo "Pending: $(grep -c 'Status.*pending' .claude/pr-split-plan.md 2>/dev/null || echo 0)"
```

## Orientation (Start of Turn)

```bash
echo "Branch: $(git branch --show-current)"
grep -n "$(git branch --show-current)" .claude/pr-split-plan.md 2>/dev/null \
    || echo "(branch not found in plan)"
grep -c 'Status.*done' .claude/pr-split-plan.md 2>/dev/null || echo "0 done"
grep -c 'Status.*pending' .claude/pr-split-plan.md 2>/dev/null || echo "0 pending"
[ -d .claude/pr-head-worktree ] && echo "Worktree: OK" || echo "Worktree: MISSING"
```

## Worktree Management

```bash
# Create (during init)
git worktree add .claude/pr-head-worktree <SHA> --detach --quiet

# Recreate if missing
git worktree add .claude/pr-head-worktree \
    $(jq -r .head_sha .claude/workspace-meta.json) --detach

# Remove (cleanup)
git worktree remove .claude/pr-head-worktree

# Verify
ls .claude/pr-head-worktree/ > /dev/null && echo "OK" || echo "MISSING"
```

## Import Extraction (for Dependency Graph)

```bash
# Rust
awk -F'\t' '$NF ~ /\.rs$/ {print $NF}' .claude/pr-files.tsv | while read f; do
    [ -f ".claude/pr-head-worktree/$f" ] || continue
    grep -nE '^use (crate|super|self)::' ".claude/pr-head-worktree/$f" 2>/dev/null \
        && echo "  ^^^ $f"
done

# TypeScript
awk -F'\t' '$NF ~ /\.tsx?$/ {print $NF}' .claude/pr-files.tsv | while read f; do
    [ -f ".claude/pr-head-worktree/$f" ] || continue
    grep -nE "from ['\"]\.\.?/" ".claude/pr-head-worktree/$f" 2>/dev/null \
        && echo "  ^^^ $f"
done

# Python
awk -F'\t' '$NF ~ /\.py$/ {print $NF}' .claude/pr-files.tsv | while read f; do
    [ -f ".claude/pr-head-worktree/$f" ] || continue
    grep -nE '^from \.|^import \.' ".claude/pr-head-worktree/$f" 2>/dev/null \
        && echo "  ^^^ $f"
done

# Go
awk -F'\t' '$NF ~ /\.go$/ {print $NF}' .claude/pr-files.tsv | while read f; do
    [ -f ".claude/pr-head-worktree/$f" ] || continue
    grep -nE '"[^"]*/' ".claude/pr-head-worktree/$f" 2>/dev/null \
        && echo "  ^^^ $f"
done
```
