# Partial File Changes

When a single file's changes span multiple slices and this is NOT the last slice
touching it, you can't `cp` the final state from the worktree. Apply only this
slice's hunks.

## When This Applies

Check `.claude/accounting.tsv`. If a file appears in multiple slices and later
slices still need it, use partial application for all slices except the last one.

## Extract → Filter → Apply → Verify

### Extract the file's diff

```bash
awk '/^diff --git a\/path\/to\/file b\/path\/to\/file$/,/^diff --git /' \
    .claude/pr-full.diff | head -n -1 > /tmp/file.patch
```

Inspect hunks:
```bash
grep '^@@' /tmp/file.patch
```

### Filter to this slice's hunks

If all hunks belong to this slice:
```bash
git apply --3way /tmp/file.patch
```

If only some hunks belong — filter by hunk number (1-indexed):
```bash
# Keep diff header (before first @@) and hunks 1 and 3
awk '/^@@/{n++} n==0 || n==1 || n==3' /tmp/file.patch > /tmp/file-partial.patch
git apply --3way /tmp/file-partial.patch
```

### Apply

```bash
git apply --3way /tmp/file-partial.patch
git add path/to/file
```

If `git apply` fails:
```bash
git apply --3way -C0 /tmp/file-partial.patch           # relax context matching
git apply --3way --recount /tmp/file-partial.patch      # recalculate offsets
```

If still failing, fall back to manual edit: read the hunk from the patch,
apply the exact same lines to the file. Copy character-for-character.

### Verify

```bash
# Compare result against worktree — remaining diff should be later slices only
diff path/to/file .claude/pr-head-worktree/path/to/file

# The staged change must be a subset of the full file diff
git diff HEAD -- path/to/file
# Every changed line here must also appear in /tmp/file.patch
```

## When to Avoid Splitting

If more than 3 hunks need surgical extraction from one file, consider putting
the entire file in one slice. Note the decision in the plan's Issues section.
