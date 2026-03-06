#!/usr/bin/env bash
# Upload env vars from a .env file to a Vercel environment.
# Only adds vars that don't already exist — never removes or overwrites.
#
# Usage: cd demo && bash scripts/set-vercel-env.sh <env-file> <vercel-environment>
#
# Examples:
#   bash scripts/set-vercel-env.sh .env.restore production
#   bash scripts/set-vercel-env.sh .env.restore preview
#   bash scripts/set-vercel-env.sh .env ekubo-demo
#
# Requires: `vercel` CLI linked to the project (demo/.vercel/project.json).

set -uo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <env-file> <vercel-environment>"
  echo "  env-file:            path to .env file with KEY=VALUE lines"
  echo "  vercel-environment:  production | preview | development | <custom>"
  exit 1
fi

ENV_FILE="$1"
ENV="$2"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: file not found: $ENV_FILE"
  exit 1
fi

# Collect vars from file
declare -a NAMES=()
declare -a VALUES=()

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^# || "$line" =~ ^VERCEL_ ]] && continue

  name="${line%%=*}"
  value="${line#*=}"

  # Strip surrounding quotes if present
  if [[ "$value" =~ ^\"(.*)\"$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi

  NAMES+=("$name")
  VALUES+=("$value")
done < "$ENV_FILE"

echo "Will add ${#NAMES[@]} vars to environment: $ENV"
echo "================================================"
for name in "${NAMES[@]}"; do
  echo "  $name"
done
echo ""

added=0
skipped=0

for idx in "${!NAMES[@]}"; do
  name="${NAMES[$idx]}"
  value="${VALUES[$idx]}"

  echo "--- [$((idx + 1))/${#NAMES[@]}] $name ---"
  npx vercel env add "$name" "$ENV" --value "$value" || true

  echo ""
done

echo "Done! Verify with:"
echo "  npx vercel env pull .env.verify --environment=$ENV"
