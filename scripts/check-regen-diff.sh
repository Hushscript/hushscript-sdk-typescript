#!/usr/bin/env bash
# Fails when a regeneration touched anything other than openapi.json and src/generated/.
set -euo pipefail

unexpected="$(git status --porcelain --untracked-files=all | cut -c4- | grep -Ev '^(openapi\.json|src/generated/.*)$' || true)"
if [ -n "$unexpected" ]; then
  echo "regeneration touched files outside openapi.json and src/generated/:" >&2
  echo "$unexpected" >&2
  exit 1
fi
