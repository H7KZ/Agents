# 0006. Hooks: scoped safety guard and verification Stop gate
Status: accepted (2026-11-15)
## Context
Hooks can block bad actions and enforce verification, but always-on checks slow every session and LLM judges are unpredictable.
## Decision
(a) Global safety guard (PreToolUse, always on). (b) Verification Stop gate registered by `/h7:work` and `/h7:ship` frontmatter only. (c) No global format-on-edit. Rules only, no LLM judge; near-misses logged for promotion.
## Alternatives considered
- Always-on gate for every session (slows and intrudes on unrelated work).
- Warn-only gate (does not stop unverified output).
- LLM judge for rule checks (nondeterministic).
## Consequences
- Verification is enforced only inside the workflow commands.
- Near-misses in `~/.h7/guard.log` feed future rule promotion.
