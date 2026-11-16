# Feature map: <app>

One file per user-facing feature. Read the file for the feature you changed, then drive it.

## Baseline preconditions

- <state every feature assumes, e.g. seeded user, empty database, env vars (names only)>

## Driving conventions

- Harness: <Playwright, Cypress, curl, PTY>. Selectors: <convention>.
- Save evidence under `.h7/evidence/<app>/<feature>/`.

## Reporting

- Report each feature as proven (with evidence path) or skipped (with the reason).
- A skipped entry point is not verified by another path.
- Never weaken a journey to make it pass.

## Features

- [<feature>](<feature>.md): <one line>
