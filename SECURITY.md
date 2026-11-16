# Security policy

## Scope and threat model

h7 is a Claude Code plugin. Its always-on guard is an **accident floor, not a sandbox**: it blocks or asks on clearly
destructive agent commands (force pushes, hook skipping, secret commits, recursive deletes outside the repo) and fails
to *ask* whenever it cannot resolve a command statically. It does not stop a determined attacker or a malicious
repository from harming you. Do not rely on it to run untrusted agents or untrusted repositories unattended.

Things h7 does on purpose:

- Reads repository files as **data**, never as instructions (skills say so; reviewers return findings only with a
  reproducing command and output, and commands outside a read-only allowlist ask you first).
- Runs `git` with hardened options (no fsmonitor, no hooks, no textconv or attribute drivers from repo config).
- Writes only inside the repo (`.h7/`, `.git/info/exclude`, files you approve) and `~/.h7` (per-machine, owner-only).
  Writes are atomic and refuse symlinks and paths that leave the repo.
- Redacts secrets and URL credentials before writing logs, journals and proposals.
- Sends nothing anywhere: no telemetry, no network calls from the plugin scripts. The CI watcher only runs your local
  `gh` against the PR you point it at.

Known limits: reviewer subagents have a Bash tool restricted by prompt only; the guard's shell parsing is best effort
(ambiguity asks or blocks); `H7_GUARD=off` and the ask-mode config are deliberate escape hatches.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's **private vulnerability reporting** on this
repository (Security tab, "Report a vulnerability"). Include the version (commit SHA), your OS and Node version, the
exact input or command, and what you expected. You will get an acknowledgement within a week.

Guard bypasses (a destructive command the guard allows) are in scope and welcome, but remember the documented
limits above; a report with a reproducing command is the most useful kind.

## Supported versions

Only the latest commit on `main` (the plugin has no version number; the commit SHA is the version).
