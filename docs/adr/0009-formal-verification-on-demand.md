# 0009. Formal verification proposed on demand
Status: accepted (2026-11-15)
## Context
Some changes (concurrency, ordering, multi-device state, state machines, invariant-heavy algorithms) need stronger checks than tests. Formal tools are costly and not needed everywhere.
## Decision
Proposed by the driver when the change touches concurrency, ordering, multi-device state, state machines or invariant-heavy algorithms; user decides. Each check records covered files + sync commit, must be shown failing on a broken variant, TLA+ results rendered as statecharts. Toolchain on demand.
## Alternatives considered
- Always run formal checks (too costly for ordinary changes).
- Never run formal checks (misses subtle invariant bugs).
## Consequences
- Formal checks are opt-in per change, with the user deciding.
- Each check must prove it can fail before it counts.
