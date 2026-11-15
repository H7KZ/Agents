# 0011. Loop termination: fixed done predicate with stagnation brake
Status: accepted (2026-11-15)
## Context
The verify-review loop needs a clear end. Without a limit it can run forever, and a relaxed predicate would let weak work pass.
## Decision
Done = all bar layers pass/N-A, zero proven findings, no open user decisions, full local check suite green. Predicate never relaxed (weakening a test is a user decision). Brake: 5 consecutive non-improving rounds → stop and report.
## Alternatives considered
- Hard cap on rounds (stops arbitrarily, even when progress is real).
- No cap (can loop indefinitely on a stuck problem).
## Consequences
- Stuck runs stop and report instead of spinning.
- Relaxing the predicate always requires the user.
