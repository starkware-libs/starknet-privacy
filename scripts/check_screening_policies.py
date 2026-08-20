#!/usr/bin/env python3.10
"""Asserts the `OpenNoteScreeningPolicy` enum agrees across Cairo, the committed pool ABI and the
proof interceptor. Not the policy list itself, which is pool storage: the set of policies and the
order they are declared in.

The pool answers with a variant index, so a name's position is what turns it back into a policy: a
reorder makes both sides read a policy the pool never meant. Nothing else connects the three copies,
since no CI job regenerates the ABI from Cairo.

Runs unfiltered on every pull request, so a change to any of the three is checked against the others.
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CAIRO_SOURCE = REPO_ROOT / "packages/privacy/src/objects.cairo"
ABI_SOURCE = REPO_ROOT / "sdk/src/internal/abi.ts"
INTERCEPTOR_SOURCE = REPO_ROOT / "proof-interceptor/src/screening-policy.ts"

ENUM_NAME = "OpenNoteScreeningPolicy"
ABI_ENUM_NAME = f"privacy::objects::{ENUM_NAME}"

CAIRO_PATTERN = re.compile(rf"pub enum {ENUM_NAME} \{{(.*?)\n\}}", re.DOTALL)
CAIRO_VARIANT_PATTERN = re.compile(r"^\s{4}([A-Z]\w*),", re.MULTILINE)
UNION_PATTERN = re.compile(rf'export type {ENUM_NAME} =([^;]*);', re.DOTALL)
UNION_MEMBER_PATTERN = re.compile(r'"(\w+)"')


def cairo_variants() -> list[str]:
    body = CAIRO_PATTERN.search(CAIRO_SOURCE.read_text())
    if body is None:
        sys.exit(f"{CAIRO_SOURCE}: `pub enum {ENUM_NAME}` not found. Did it move or change shape?")
    return CAIRO_VARIANT_PATTERN.findall(body.group(1))


def abi_variants() -> list[str]:
    # The ABI is a TypeScript file wrapping one JSON array; take the array and parse it as JSON.
    text = ABI_SOURCE.read_text()
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1:
        sys.exit(f"{ABI_SOURCE}: no JSON array found. Did the generated file change shape?")
    for item in json.loads(text[start : end + 1]):
        if item.get("type") == "enum" and item.get("name") == ABI_ENUM_NAME:
            return [variant["name"] for variant in item["variants"]]
    sys.exit(f"{ABI_SOURCE}: {ABI_ENUM_NAME} is missing. Regenerate it with `npm run generate:abi`.")


def union_members() -> list[str]:
    union = UNION_PATTERN.search(INTERCEPTOR_SOURCE.read_text())
    if union is None:
        sys.exit(f"{INTERCEPTOR_SOURCE}: `export type {ENUM_NAME}` not found. Did it move?")
    return UNION_MEMBER_PATTERN.findall(union.group(1))


def main() -> None:
    policies = {
        CAIRO_SOURCE: cairo_variants(),
        ABI_SOURCE: abi_variants(),
        INTERCEPTOR_SOURCE: union_members(),
    }
    if len(set(map(tuple, policies.values()))) > 1:
        listed = "\n".join(
            f"  {source.relative_to(REPO_ROOT)}: {names}" for source, names in policies.items()
        )
        sys.exit(
            "The open-note screening policies disagree, in name or in order:\n"
            f"{listed}\n"
            "Order is the serde index the pool answers with, so it has to match too. Cairo owns the "
            "list: regenerate the ABI with `npm run generate:abi` in sdk/, then update the "
            "interceptor's union and the policies it screens on."
        )
    print(f"Open-note screening policies agree: {policies[CAIRO_SOURCE]}")


if __name__ == "__main__":
    main()
