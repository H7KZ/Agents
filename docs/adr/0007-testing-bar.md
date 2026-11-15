# 0007. Testing bar scoped to the change
Status: accepted (2026-11-15)
## Context
Verification replaces line-by-line review, so the bar must be strict. A whole-repo bar is slow and punishes unrelated code, so the scope must follow the change.
## Decision
Scope = what the change touches, never the whole repo. All layers that suit the work: lint, types, unit, 100% diff line+branch coverage with no global drop, mutation ≥80% on changed files every run, written edge-case matrix, property-based, e2e via the repo verify skill, Bombadil for web/TUI, regression test per bug (committed failing first). Each layer passes or is N/A with a reason. Thresholds overridable in `verification.md`.
## Alternatives considered
- Lighter bar (too weak to replace review).
- Whole-repo 100% coverage (slow, blocks unrelated changes).
## Consequences
- Every layer must be passed or justified as N/A.
- Thresholds can be tuned per repo in `verification.md`.
