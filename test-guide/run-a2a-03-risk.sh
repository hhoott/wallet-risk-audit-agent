#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

ADDRESS="0xD90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b"
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
