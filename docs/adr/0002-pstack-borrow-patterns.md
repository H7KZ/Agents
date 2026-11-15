# 0002. pstack: borrow patterns, write own skills
Status: accepted (2026-11-15)
## Context
pstack and mattpocock/skills overlap with the workflow. Adopting them wholesale would couple h7 to their release cadence and design.
## Decision
Borrow patterns and write own skills. Port real code (watch-pr, check-plan) with MIT attribution. mattpocock/skills stays an external dependency.
## Alternatives considered
- Depend on pstack as a package (couples h7 to its releases).
- Fork pstack (duplicates maintenance).
## Consequences
- h7 owns its skills; ported code carries MIT attribution.
- mattpocock/skills is installed as a dependency, not copied.
