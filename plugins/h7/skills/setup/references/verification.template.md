# Verification

Written by `/h7:setup` on <YYYY-MM-DD>. Re-run `/h7:setup` after tooling or CI changes.
Status per command: `verified <YYYY-MM-DD>`, `UNVERIFIED: <why>`, `FAILING: <first error line>`, or `GAP: <what is missing>`.

## Commands

Run from the repo root. Scope every run to what the change touches.

| Layer | Command | Status |
|---|---|---|
| Install | `<install command>` | <status> |
| Typecheck | `<command>` | <status> |
| Lint | `<command>` | <status> |
| Format (check only) | `<command>` | <status> |
| Unit | `<command>` | <status> |
| Coverage | `<command that writes a report>` | <status> |
| Diff coverage | `<command comparing the report to the default branch>` | <status> |
| Mutation (changed files) | `<command taking a file list or diff>` | <status> |
| Property | `<command or "runs inside unit">` | <status> |
| E2E | `<command, or the verify-<app> skill>` | <status> |
| Full local check | `<what CI runs on pull requests>` | <status> |

## Thresholds

Defaults from the h7 testing bar. Edit a value to override it for this repo.

- Diff coverage: 100% lines and branches on changed code.
- Global coverage: must not drop.
- Mutation score on changed files: at least 80%.

## App surfaces

| Surface | Kind | Dir | Run | Verify skill |
|---|---|---|---|---|
| `<name>` | <web, api, cli, desktop> | `<dir>` | `<run command>` | `.claude/skills/verify-<app>/SKILL.md` (<PROVEN or BLOCKED>) |

## CI

- Provider: <provider>. Workflows: <files>.
- Jobs and what they run: <job: commands, one line each>.
- Watch: `gh pr checks --watch` (PR) or `gh run list --branch <branch> --limit 5`.
- Failure log: `gh run view <run-id> --log-failed`.
- Rerun failed jobs: `gh run rerun <run-id> --failed`.

Use the provider's equivalents when it is not GitHub Actions, or write `GAP: no CLI recipe for <provider>`.

## Ship

- Ship mode: <pr or push> (asked on <date>, or defaulted: <why>).
- Auto-merge: <off or on>. Default off; only the repo owner turns it on.
- Commit convention: <conventional, or the observed style>.
- Default branch: <name>. Protected-looking branches: <list>. Never push to them directly.

## Layers not applicable

| Layer | Reason |
|---|---|
| <layer> | <reason> |

## Gaps

| Missing | Recommended | Note |
|---|---|---|
| <e.g. no mutation tool> | <tool for this stack> | `/h7:verify` installs after approval |
