# 0010. Review: fresh-context subagent lenses with proven findings
Status: accepted (2026-11-15)
## Context
Self-review by the authoring model misses its own blind spots. Reviews must produce evidence, not opinions, and must not be noise.
## Decision
Fresh-context subagent reviewers, one lens each: spec, standards, adversarial, security, performance, test quality, architecture/simplicity. Driver picks relevant lenses and logs skips. Finding survives only with command + output the parent reruns. Reviewer model ≠ author model (per-machine model-roles config). Optional cross-vendor reviewer if `codex`/`gemini` is installed.
## Alternatives considered
- Fewer lenses (misses classes of defects).
- Mandatory cross-vendor reviewer (requires extra tools on every machine).
## Consequences
- Each finding carries a reproducible command and output.
- Reviewer model is set per machine in `~/.h7/models.json`.
