#!/usr/bin/env sh
# Thin wrapper: all logic lives in configure.ts. Usage: install.sh [--dry-run] [--local <path>] [--yes]
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo "error: Node 22.18 or newer is required (https://nodejs.org)" >&2
  exit 1
fi
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/configure.ts" "$@"
