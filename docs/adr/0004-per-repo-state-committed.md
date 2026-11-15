# 0004. Per-repo state committed in each target repo
Status: accepted (2026-11-15)
## Context
Each target repo needs its own verification recipe, feature map and agent rules. Machines must not diverge on repo-specific knowledge.
## Decision
Committed in each target repo, written by `/h7:setup`: `docs/agents/verification.md`, `.claude/skills/verify-<app>/` (recipe + feature map), `AGENTS.md` section (principles, rule↔enforcer table, commands), `CLAUDE.md` containing `@AGENTS.md`.
## Alternatives considered
- Keep state in the plugin, keyed by repo (hidden from the repo, not reviewable).
- Keep state local only (not shared across machines or collaborators).
## Consequences
- Repo state is reviewed and versioned with the code.
- `/h7:setup` must be re-run or updated when conventions change.
