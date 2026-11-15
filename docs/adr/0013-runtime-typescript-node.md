# 0013. Runtime: TypeScript on Node type stripping
Status: accepted (2026-11-15)
## Context
Hooks and CLIs must run on Windows, macOS and Linux with no install step beyond the agent itself. Dependencies add supply-chain and install cost.
## Decision
Hooks and CLIs in TypeScript run by Node ≥22.18 type stripping, zero dependencies, tests on `node:test`. This repo has CI on windows/macos/ubuntu.
## Alternatives considered
- Bun (extra runtime to install).
- Python (extra runtime and dependency management across platforms).
## Consequences
- Node ≥22.18 is required on every machine.
- No third-party dependencies; tests use the built-in runner.
