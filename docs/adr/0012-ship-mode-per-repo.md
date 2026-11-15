# 0012. Ship: per-repo mode, CI watcher, no auto-merge
Status: accepted (2026-11-15)
## Context
Repos differ in how they ship. Shipping must be verified, CI failures must re-enter the loop, and merging must never happen by surprise.
## Decision
Ship mode per repo (`pr` / `push`), overridable per run. Repo's commit convention, else Conventional Commits. PR body: Why / What changed / Scope / Blast radius / Verification / Review / Decisions. CI watcher CLI (GitHub only for now, verdict model provider-agnostic): READY / WAITING / BLOCKED with blocker kinds; triage flake (1 rerun) vs stale base vs real failure. Never merges unless the repo opts in.
## Alternatives considered
- Auto-merge by default (risky without opt-in).
- Single fixed ship mode for all repos (ignores repo practice).
## Consequences
- Merging requires explicit per-repo opt-in.
- CI watcher is GitHub-only until other providers are added.
