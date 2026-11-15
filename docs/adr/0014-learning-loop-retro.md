# 0014. Learning loop: retro proposes checks, improvements queue
Status: accepted (2026-11-15)
## Context
Each real mistake should make the environment stronger. Proposed checks must be proven against real past mistakes and must not be added unreviewed.
## Decision
`/h7:retro`: proposes checks for the target repo (architecture → types → lint → test → prose), each proven against a real past mistake, user approves row by row, separate commits. h7 improvements queue in `~/.h7/proposals/`; `/h7:improve` in this repo drafts them, user approves.
## Alternatives considered
- Automatic check creation (adds unreviewed rules).
- Improvements applied directly to h7 without a queue (no approval step).
## Consequences
- Every new check traces to a real past mistake.
- Approved checks land as separate commits for easy revert.
