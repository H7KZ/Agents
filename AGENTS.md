# AGENTS.md

This repo is the `h7kz` Claude Code plugin marketplace with one plugin, `h7`: a universal agent workflow
(safety guard, verification, review, ship). Design: `docs/design.md`. Decisions: `docs/adr/`.

## Layout

```
.claude-plugin/marketplace.json   marketplace "h7kz" -> plugins/h7
plugins/h7/.claude-plugin/        plugin.json (name "h7", NO version)
plugins/h7/hooks/hooks.json       PreToolUse safety guard (exec form: node + args)
plugins/h7/scripts/*.ts           runtime code (guard, doctor, verify and review helpers)
plugins/h7/skills/<name>/SKILL.md user-invoked skills (/h7:<name>)
plugins/h7/agents/review-<lens>.md read-only reviewer subagents spawned by /h7:review
test/plugin/                      node:test suites (*.test.ts fast, *.e2e.ts slow subprocess)
bootstrap/                        install.ps1, install.sh, configure.ts (+ test/); --dev links plugins/h7 for live edits
scripts/                          repo tooling: lint-skills.ts, check-manifests.ts (+ test/)
```

## Commands

- `npm ci` install dev tooling (TypeScript 5.9, @types/node, fast-check, Stryker)
- `npm run check` typecheck, skill lint, manifest check, all tests (fast, run before every commit)
- `npm run test:coverage` tests with 100% line/branch/function gate
- `npm run mutation` Stryker (tap-runner, perTest, incremental in reports/stryker-incremental.json), break 80; full run about 9 min locally, unchanged rerun about 15 s; CI is incremental from the cache saved on main (25 min cap, changed files only without a cache), full run weekly in mutation-full.yml; spawning tests are skipped via H7_MUTATION=1
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
| Hooks in exec form, script exists | `scripts/check-manifests.ts` (hook args under `${CLAUDE_PLUGIN_ROOT}` must exist); `test/plugin/guard-core.test.ts` asserts hooks.json shape |
| No `version` in plugin.json, names match | `scripts/check-manifests.ts` |
| Valid JSON manifests | `scripts/check-manifests.ts`; `claude plugin validate` in CI |
| Skills: name equals dir, description at most 1024, user-only, at most 500 lines, links resolve | `scripts/lint-skills.ts` (`npm run lint:skills`) |
| Agents have name and description | `scripts/lint-skills.ts` |
| 100% coverage | `npm run test:coverage` (CI, all 6 matrix cells) |
| Mutation score at least 80 | `npm run mutation` (CI job) |
| Works on Windows, macOS, Linux, Node 22.18 and 24 | `.github/workflows/ci.yml` matrix |
| Guard blocks force push to protected branches (and deleting them), hook skipping (flags, abbreviations, core.hooksPath outside the repo; inside the repo only .husky, .githooks, .git/hooks pass, others ask), destructive git on a dirty tree (tracked changes; untracked for `git clean`), secret commits (high-confidence names, `.pem` with a private key), recursive deletes outside repo, `rm -rf .git`, `find -delete` outside repo | `test/plugin/rules-*.test.ts`, `hardening.test.ts`, `uncertainty.test.ts`, `guard.e2e.ts` |
| Guard asks for protected pushes, deploy/publish (option-aware, wrappers, `--dry-run` allowed), ambiguous secrets, history rewrites, stash drop, git aliases | `test/plugin/rules-git.test.ts`, `rules-deploy.test.ts`, `hardening.test.ts` |
| Guard asks on what it cannot resolve: git failing or missing, shell/interpreter stdin, `xargs`, `iex`, variable command words, `cd x || ...`, unresolved targets | `test/plugin/failsafe.test.ts`, `hardening.test.ts`, `uncertainty.test.ts`, `braces.test.ts` |
| Ask mode per machine (env H7_GUARD_ASK or the owner-only config in ~/.h7): allow/deny never weaken blocks; internal errors never become a silent allow; agents cannot edit the config (shell mentions and Write/Edit on it block) | `test/plugin/askmode.test.ts` |
| Guard state across a chain (branch, stash, cd, staged files; subshells isolated) | `test/plugin/hardening.test.ts` |
| Non-git commands never spawn git | `test/plugin/failsafe.test.ts` |
| Guard log has no secrets, private permissions | `test/plugin/log.test.ts` (property test) |
| Git is run safely in untrusted repos | `test/plugin/git.test.ts` |
| Bootstrap idempotent, backs up the original settings, atomic write, confirms before cleanup | `bootstrap/test/configure.test.ts` |
| Zero deps in plugin, `node:`-only runtime imports, exec-form hooks | `scripts/check-manifests.ts` |
| Doctor reports dev vs marketplace mode, never both | `test/plugin/doctor.test.ts` |
| `/h7:verify` scopes the bar to the change: files and line ranges vs merge base, diff line and branch coverage from lcov, global-drop check | `test/plugin/verify-scope.test.ts`, `diff-coverage.test.ts`, `verify-skill.test.ts` |
| Stop gate blocks only while `.h7/verify.json` is incomplete; fails open on internal errors, honors `stop_hook_active`, caps its own blocks; registered by work/ship frontmatter only, never in `hooks.json` | `test/plugin/verify-gate.test.ts`, `verify-state.test.ts`, `verify-skill.test.ts` |
| Repo-configured textconv and attribute drivers never run in h7 diffs | `test/plugin/verify-scope.test.ts`, `git.test.ts` |
| Review agents: one per lens, tools exactly `Read, Grep, Glob, Bash` (no Write/Edit/MultiEdit/NotebookEdit), name and description, spawned only by `/h7:review`, report format the findings parser accepts | `scripts/lint-skills.ts`, `test/plugin/review-agents.test.ts` |
| A review finding survives only with a reproducing command and its output (unproven dropped, duplicates merged, ranked); the parent keeps only reproduced ids | `test/plugin/review-findings.test.ts`, `review-skill.test.ts` |
| Lens picker covers every lens exactly once, selected or skipped with a reason | `test/plugin/review-lenses.test.ts` |
| Reviewer model resolved from `~/.h7/models.json` (`H7_HOME` override), safe on missing or corrupt file, read only, never equal to the author model; codex/gemini detected on PATH without running | `test/plugin/models.test.ts` |
| CI verdict from checks, review threads and mergeability: READY only with nothing failing, pending, conflicting or unresolved; one rerun per failure per head, stale base and real failure separated; never recommends merging | `test/plugin/ci-verdict.test.ts` (property tests) |
| `ci-watch.ts` shells out to `gh` only through an injected runner, absolute PATH entries only, no shell; missing or unauthenticated gh, bad output and unreadable threads give BLOCKED, never a guess; rerun recorded before it is requested | `test/plugin/ci-watch.test.ts` |
| `/h7:ship` registers the Stop gate in its own frontmatter, has all PR body sections, never pushes or merges unasked | `scripts/lint-skills.ts`, `test/plugin/ship-skill.test.ts` |
| Skills never auto-trigger | `scripts/lint-skills.ts` |
| AGENTS.md at most 150 lines | none yet |
| Conventional Commits | none yet |
| Each commit passes `npm run check` | none yet |
| No pushes without being asked | none yet |

## Notes for agents

- `${CLAUDE_PLUGIN_ROOT}` is substituted in SKILL.md bodies and hook configs, not in Bash commands.
- The guard runs on every Bash/PowerShell call: keep rules pure and fast, spawn git only when a rule needs it.
- Stryker needs the TypeScript JS API, hence TypeScript 5.9 (TypeScript 7 removed it).
