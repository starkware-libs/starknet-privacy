#!/usr/bin/env python3.10
"""Asserts the Primer class hash agrees between Cairo and TypeScript.

Every shadow account address derives from this class hash, so the anonymizer cements it and the SDK
mirrors it to predict addresses off-chain. If the two drift, the SDK predicts addresses that hold no
funds and the proof interceptor screens the wrong one, and nothing fails loudly.

Runs unfiltered on every pull request, so a change to either side is checked against the other.
"""

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CAIRO_SOURCE = REPO_ROOT / "packages/shadow_account_anonymizer/src/shadow_account_anonymizer.cairo"
TS_SOURCE = REPO_ROOT / "sdk/src/internal/shadow-account-address.ts"

CAIRO_PATTERN = re.compile(
    r"pub const PRIMER_CLASS_HASH: ClassHash\s*=\s*(0x[0-9a-fA-F_]+)", re.MULTILINE
)
TS_PATTERN = re.compile(r"export const PRIMER_CLASS_HASH\s*=\s*(0x[0-9a-fA-F_]+)n", re.MULTILINE)


def extract(source: Path, pattern: re.Pattern) -> int:
    match = pattern.search(source.read_text())
    if match is None:
        sys.exit(f"{source}: PRIMER_CLASS_HASH not found. Did the declaration change shape?")
    return int(match.group(1).replace("_", ""), 16)


def main() -> None:
    cairo_class_hash = extract(CAIRO_SOURCE, CAIRO_PATTERN)
    ts_class_hash = extract(TS_SOURCE, TS_PATTERN)
    if cairo_class_hash != ts_class_hash:
        sys.exit(
            "PRIMER_CLASS_HASH disagrees between Cairo and TypeScript:\n"
            f"  {CAIRO_SOURCE.relative_to(REPO_ROOT)}: {cairo_class_hash:#066x}\n"
            f"  {TS_SOURCE.relative_to(REPO_ROOT)}: {ts_class_hash:#066x}\n"
            "Every off-chain shadow account address derives from this value; update both."
        )
    print(f"PRIMER_CLASS_HASH agrees: {cairo_class_hash:#066x}")


if __name__ == "__main__":
    main()
