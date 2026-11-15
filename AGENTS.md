# AGENTS.md

This repo is the `h7kz` Claude Code plugin marketplace with one plugin, `h7`: a universal agent workflow
(safety guard, verification, review, ship). Design: `docs/design.md`. Decisions: `docs/adr/`.

## Layout

```
.claude-plugin/marketplace.json   marketplace "h7kz" -> plugins/h7
plugins/h7/.claude-plugin/        plugin.json (name "h7", NO version)
plugins/h7/hooks/hooks.json       PreToolUse safety guard (exec form: node + args)
plugins/h7/scripts/*.ts           runtime code (guard, doctor, helpers)
plugins/h7/skills/<name>/SKILL.md user-invoked skills (/h7:<name>)
plugins/h7/test/                  node:test suites (*.test.ts fast, *.e2e.ts slow subprocess)
bootstrap/                        install.ps1, install.sh, configure.ts (+ test/)
scripts/                          repo tooling: lint-skills.ts, check-manifests.ts (+ test/)
```

## Commands

- `npm ci` install dev tooling (TypeScript 5.9, @types/node, fast-check, Stryker)
- `npm run check` typecheck, skill lint, manifest check, all tests (fast, run before every commit)
- `npm run test:coverage` tests with 100% line/branch/function gate
- `npm run mutation` Stryker (tap-runner, perTest, incremental in reports/stryker-incremental.json), break 80; full run about 9 min, unchanged rerun about 15 s; spawning tests are skipped via H7_MUTATION=1
- `claude plugin validate ./plugins/h7` and `claude plugin validate .` (the "no version" warning is intended)

## Hard rules

1. Runtime code under `plugins/h7/scripts` is TypeScript run by `node file.ts` (Node 22.18+ type stripping):
   erasable syntax only (no enums, namespaces, parameter properties), explicit `.ts` import extensions,
   Node built-ins only, zero runtime dependencies. Dev-only deps live at the repo root.
2. Cross-platform: forward slashes in config; hooks in exec form
   `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/guard.ts"]}`; no bash-only logic in hooks.
3. Every h7 skill has `disable-model-invocation: true`; nothing auto-triggers.
4. `plugin.json` has no `version` (commit SHA is the version).
5. Tests: node:test, unit plus property-based (fast-check) plus subprocess fixtures plus temp git repos.
   Coverage stays 100% line, branch and function. Tests touching HOME use a temp dir (`H7_HOME`).
6. Never modify anything outside the repo from tests or scripts under test; never run the bootstrap for real in tests.
7. Safety guard fails to ASK (never allow) on internal errors; `H7_GUARD=off` is the only escape hatch.
8. Guard log (`~/.h7/guard.log`) must never contain secrets: redaction happens before write.
9. Conventional Commits, small and staged; each commit passes `npm run check`. Never push without being asked.
10. AGENTS.md stays at or under 150 lines.

## Rule <-> enforcer

| Rule | Enforcer |
|---|---|
| Erasable TS syntax, `.ts` import extensions | `npm run typecheck` (tsconfig: erasableSyntaxOnly, allowImportingTsExtensions, strict) |
| Zero runtime deps in plugin | `plugins/h7/package.json` has no dependencies; imports are `node:` only (typecheck fails on missing modules) |
| Hooks in exec form, script exists | `scripts/check-manifests.ts` (hook args under `${CLAUDE_PLUGIN_ROOT}` must exist); `plugins/h7/test/guard-core.test.ts` asserts hooks.json shape |
| No `version` in plugin.json, names match | `scripts/check-manifests.ts` |
| Valid JSON manifests | `scripts/check-manifests.ts`; `claude plugin validate` in CI |
| Skills: name equals dir, description at most 1024, user-only, at most 500 lines, links resolve | `scripts/lint-skills.ts` (`npm run lint:skills`) |
| Agents have name and description | `scripts/lint-skills.ts` |
| 100% coverage | `npm run test:coverage` (CI, all 6 matrix cells) |
| Mutation score at least 80 | `npm run mutation` (CI job) |
| Works on Windows, macOS, Linux, Node 22.18 and 24 | `.github/workflows/ci.yml` matrix |
| Guard blocks force push to protected branches, hook skipping, destructive git on dirty tree, secret commits, recursive deletes outside repo | `plugins/h7/test/rules-*.test.ts`, `guard.e2e.ts` |
| Guard asks for protected pushes and deploy/publish | `plugins/h7/test/rules-git.test.ts`, `rules-deploy.test.ts` |
| Guard errors and unresolvable targets ask | `plugins/h7/test/failsafe.test.ts`, `braces.test.ts` |
| Guard log has no secrets, private permissions | `plugins/h7/test/log.test.ts` (property test) |
| Git is run safely in untrusted repos | `plugins/h7/test/git.test.ts` |
| Bootstrap idempotent, backs up settings, confirms before cleanup | `bootstrap/test/configure.test.ts` |
| Skills never auto-trigger | `scripts/lint-skills.ts` |
| AGENTS.md at most 150 lines | none yet |
| Conventional Commits | none yet |
| Each commit passes `npm run check` | none yet |
| No pushes without being asked | none yet |

## Notes for agents

- `${CLAUDE_PLUGIN_ROOT}` is substituted in SKILL.md bodies and hook configs, not in Bash commands.
- The guard runs on every Bash/PowerShell call: keep rules pure and fast, spawn git only when a rule needs it.
- Stryker needs the TypeScript JS API, hence TypeScript 5.9 (TypeScript 7 removed it).
