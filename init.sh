#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-check}"
case "$cmd" in
  setup)
    pnpm install --frozen-lockfile
    pnpm run build:cli
    ;;
  lint)
    pnpm run lint
    ;;
  check)
    pnpm run check
    ;;
  mutate-check)
    pnpm run mutate --check
    ;;
  *)
    echo "Usage: ./init.sh [setup|lint|check|mutate-check]" >&2
    exit 2
    ;;
esac
