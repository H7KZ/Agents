# 0005. Invocation: driver command plus standalone phase skills
Status: accepted (2026-11-15)
## Context
The workflow has seven phases that must run in order, but each phase must also be usable alone. The model must not trigger these skills by accident.
## Decision
Driver `/h7:work` + standalone phase skills. All h7 skills `disable-model-invocation: true`; nothing auto-triggers. The driver loads phase skills by reading `${CLAUDE_PLUGIN_ROOT}/skills/<phase>/SKILL.md` (model cannot invoke user-only skills).
## Alternatives considered
- Model-invoked skills that auto-trigger (risks unwanted runs).
- A single monolithic driver with no standalone phases (phases unusable alone).
## Consequences
- The user controls every run; no auto-triggering.
- The driver must read phase files by path, not by skill invocation.
