# Contributing

Thanks for helping. Read `AGENTS.md` first (hard rules, rule-to-enforcer table) and `docs/design.md`.

## Setup

```sh
git clone https://github.com/H7KZ/Agents.git && cd Agents
npm ci
npm run check            # typecheck, skill lint, manifest check, all tests (run before every commit)
npm run test:coverage    # 100% line, branch and function gate
npm run mutation         # Stryker, break at 80; run locally before a PR (CI does not run it)
```

Node 22.18+ is required (runtime code is TypeScript run with Node type stripping: erasable syntax only,
explicit `.ts` import extensions, `node:` built-ins only, zero runtime dependencies).

## Rules of the road

- **Tests first.** Every behavior change comes with a test; bugs get a regression test that fails before the fix.
  Coverage stays at 100%, and must not depend on the OS (CI runs Linux and Windows, you may be on macOS).
- **Conventional Commits**, small and staged; each commit passes `npm run check`.
- **Skills never auto-trigger** (`disable-model-invocation: true`); skills stay under 500 lines.
- **The guard fails closed.** When a parser bypass is found, prefer asking or blocking on ambiguity over more
  precise parsing.
- **Never touch anything outside the repo from tests**; tests that need a home directory use a temp dir (`H7_HOME`).
- Keep `AGENTS.md` at or under 150 lines and update the rule-to-enforcer table when you add a rule.
- Security issues: see `SECURITY.md`, not a public issue.

## Pull requests

Describe why, what changed, blast radius and how you verified it. Link the issue. CI runs `npm run check` and
the coverage gate on Linux and Windows.
