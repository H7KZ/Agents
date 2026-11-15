# 0001. Harness: Claude Code first-class
Status: accepted (2026-11-15)
## Context
The workflow must run inside an agent harness that supports hooks, subagents and plugins. Skills should not lock out other agents.
## Decision
Claude Code is the first-class harness (hooks, subagents, plugin). Skills stay Agent-Skills-spec-portable so Cursor/Codex can read SKILL.md text.
## Alternatives considered
- Harness-agnostic core with no Claude Code-specific features (loses hooks and subagents).
- Claude Code-only skills with no portability (locks out other agents).
## Consequences
- Hooks, subagents and plugin packaging can be used directly.
- Other harnesses get SKILL.md text, not full behaviour.
