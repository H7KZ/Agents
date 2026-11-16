---
name: verify-<app>
description: Launch <app>, drive its user-facing features, and capture evidence that a change works. Use when verifying a change to <app>.
disable-model-invocation: true
---

# Verify <app>

Status: <PROVEN on YYYY-MM-DD, or UNPROVEN - blocker>
Surface: <web, api, cli or desktop>. Feature map: [features/README.md](features/README.md).

Run these in order. Each section ends on its stated condition.

## Launch

Start from empty state: <empty data dir, fresh database, seed command>.

```
<command that starts the app>
```

Ready means usable: <the check that proves it, e.g. a page renders with its main element, a health endpoint returns data, the CLI prints its version>. Not "the port is open".

Ends when: the ready check passes. Record the process id and port you started.

## Doctor

Read-only. Answers "is this instance worth driving?" without changing anything.

- <check 1, e.g. GET /health returns 200 with a database connection>
- <check 2, e.g. the page's main element is present>

Ends when: every check passes, or you report which failed and stop.

## Drive

Use the repo's own driver first: <Playwright, Cypress, PTY, curl>. Real selectors and commands only; the per-feature recipes are in `features/`. Stable handles: <test ids, roles, routes>.

## Evidence

For each feature you drive, save under `.h7/evidence/<app>/<feature>/`:

- the action (command or steps), the resulting state (screenshot, snapshot or output), and side effects (rows written, files, requests);
- for a CLI: command, stdout, stderr, exit code;
- for a mutation: a read-only second view that shows the change.

Mock only at production boundaries (payments, email). A dry run counts only if you observed that nothing happened.

Ends when: the evidence files exist and show the behaviour under test.

## Cleanup

Kill only the processes and containers you started in Launch. Remove temp data you created. Never delete `.h7/evidence`.

Ends when: no process you started is left, and the evidence is still on disk.

## Helpers

Executable scripts in `scripts/`. Show each invocation:

```
<node scripts/launch.ts>
```
