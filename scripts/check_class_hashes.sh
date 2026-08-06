#!/usr/bin/env bash
# Verify the contract class hashes documented in README.md match the hashes
# produced by compiling the contracts with the pinned Scarb toolchain
# (.tool-versions). A class hash is deterministic from the Sierra class, so it
# changes whenever the Cairo source OR the compiler version changes.
#
# Prerequisite: `scarb --profile release build -p privacy \
#   -p ekubo_swap_anonymizer -p vesu_lending_anonymizer` has been run, and
# `starkli` is on PATH.
#
# Exits non-zero if any documented hash is missing or stale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

README="README.md"
ARTIFACT_DIR="target/release"

# README compatibility-matrix label  ->  compiled Sierra artifact basename
declare -A ARTIFACTS=(
  ["Privacy Pool"]="privacy_Privacy"
  ["Ekubo Anonymizer"]="ekubo_swap_anonymizer_EkuboSwapAnonymizer"
  ["Vesu Anonymizer"]="vesu_lending_anonymizer_VesuLendingAnonymizer"
)

# Normalize a hex string for numeric comparison (256-bit values overflow shell
# arithmetic): drop 0x, lowercase, strip leading zeros.
norm() {
  local h="${1#0x}"
  h="$(printf '%s' "$h" | tr 'A-F' 'a-f' | sed 's/^0*//')"
  printf '%s' "${h:-0}"
}

fail=0
for label in "${!ARTIFACTS[@]}"; do
  artifact="$ARTIFACT_DIR/${ARTIFACTS[$label]}.contract_class.json"
  if [[ ! -f "$artifact" ]]; then
    echo "ERROR: missing artifact '$artifact' — run 'scarb --profile release build' first." >&2
    fail=1; continue
  fi
  computed="$(starkli class-hash "$artifact")"
  documented="$(grep -E "\| *${label} " "$README" | grep -oE '0x[0-9a-fA-F]{50,}' | tail -1 || true)"
  if [[ -z "$documented" ]]; then
    echo "ERROR: no class hash documented for '$label' in $README." >&2
    fail=1; continue
  fi
  if [[ "$(norm "$computed")" == "$(norm "$documented")" ]]; then
    echo "OK    $label -> $documented"
  else
    echo "DRIFT $label:" >&2
    echo "        README:   $documented" >&2
    echo "        compiled: $computed" >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo >&2
  echo "Contract class hashes in $README are out of date — update them to the compiled values above." >&2
  exit 1
fi
echo "All contract class hashes in $README are up to date."
