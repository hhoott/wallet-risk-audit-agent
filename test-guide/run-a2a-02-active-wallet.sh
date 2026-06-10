#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ADDRESS="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
MODE="${1:-live}"

case "$MODE" in
  live)
    npm run requester:live -- "$ADDRESS"
    ;;
  dry-run)
    shift || true
    if [[ "${1:-}" != "" ]]; then
      npm run requester:dry-run -- --result-file "$1"
    else
      npm run requester:dry-run
    fi
    ;;
  *)
    echo "Usage: $0 [live|dry-run <result-file.json>]" >&2
    exit 2
    ;;
esac
