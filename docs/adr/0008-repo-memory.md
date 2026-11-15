# 0008. Repo memory: AGENTS.md, CONTEXT.md, ADRs, local run journal
Status: accepted (2026-11-15)
## Context
Agents lose context between sessions. Memory must be small enough to always load, shared where it is durable, and kept local where it is transient.
## Decision
`AGENTS.md` (≤150 lines, always loaded), `CONTEXT.md` (domain glossary), `docs/adr/`, run journal `.h7/runs/YYYY-MM-DD-<slug>.md` excluded via `.git/info/exclude` (local only).
## Alternatives considered
- Run journals committed to the repo (noisy history).
- Unbounded AGENTS.md (exceeds always-loaded budget).
## Consequences
- AGENTS.md must be actively trimmed to stay ≤150 lines.
- Journals stay on the machine that produced them.
