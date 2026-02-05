#!/usr/bin/env python3
"""
Validate PR title against Starkware-style convention:

  type(scope): description
  type: description

Rules:
- type ∈ {feat, fix, chore, ci, docs, test, perf, refactor} (lowercase)
- scope (optional): lowercase letters/digits, plus . _ / - (must start with [a-z0-9])
- description: non-empty (at least one non-space char after ": ")
"""

from __future__ import annotations

import re
import sys


ALLOWED_TYPES = ("feat", "fix", "chore", "ci", "docs", "test", "perf", "refactor")

# Allow:
# 1) type(scope): description
# 2) type: description
TITLE_RE = re.compile(
    r"^(?P<type>{types})(?:\((?P<scope>[a-z0-9][a-z0-9._/-]*)\))?: (?P<desc>.+)$".format(
        types="|".join(ALLOWED_TYPES)
    )
)


def validate_title(title: str) -> list[str]:
    errors: list[str] = []
    title = title.strip()

    if not title:
        return ["Title is empty."]

    m = TITLE_RE.match(title)
    if not m:
        errors.append(
            "Title must match either:\n"
            "- type(scope): description\n"
            "- type: description\n"
            f"Where type ∈ {{{', '.join(ALLOWED_TYPES)}}}."
        )
        return errors

    desc = m.group("desc").strip()
    if not desc:
        errors.append("Description must be non-empty.")

    return errors


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: pr_title_lint.py '<pr title>'", file=sys.stderr)
        return 2

    title = sys.argv[1].strip()
    errors = validate_title(title)

    if errors:
        print(f"❌ Invalid PR title: {title}\n")
        for e in errors:
            print(f"- {e}")

        print("\nExamples:")
        print("- ci: add PR title linting")
        print("- feat(client): add CreateNote functionality")
        return 1

    print(f"✅ PR title OK: {title}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
