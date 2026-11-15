# Thin wrapper: all logic lives in configure.ts.
# Usage: install.ps1 [--dry-run] [--local <path>] [--yes]
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine('error: Node 22.18 or newer is required (https://nodejs.org)')
  exit 1
}
& node (Join-Path $PSScriptRoot 'configure.ts') @args
exit $LASTEXITCODE
