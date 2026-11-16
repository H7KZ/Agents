# h7: design

Universal, cross-repo agent workflow for Claude Code, packaged as the `h7` plugin from the H7KZ/Agents marketplace.
Settled in a grilling session on 2026-11-15. Research: `docs/research/`. Each decision has an ADR in `docs/adr/`.

## Goal

Trust agent output by investing in the agent's environment, not by reading every diff (Lauren Tan, "All Code Is Slop").
Every correction becomes a deterministic check. Verification evidence replaces line-by-line review.

## Workflow (`/h7:work <task>`)

1. **Research**: gather context; cited notes. Reuses mattpocock `research`.
2. **Grill**: user picks between real alternatives; prototype first if a run can answer it. Reuses mattpocock `grilling` / `grill-with-docs`; decisions land as ADRs.
3. **Implement**: staged commits that tell a story (failing regression test before fix, refactor before behaviour change); agent runs the code as it goes.
4. **Verify**: the testing bar below.
5. **Review**: independent reviewers, proven findings only.
6. **Loop** 4–5 until the done predicate holds.
7. **Ship**: PR or push (per repo), watch CI, failures re-enter the loop.

Every phase is also its own command: `/h7:setup`, `/h7:verify`, `/h7:review`, `/h7:ship`, `/h7:retro`, `/h7:improve`.

`/h7:verify` helpers (`plugins/h7/scripts/`): `verify-scope.ts` (changed files and line ranges vs merge base, JSON), `diff-coverage.ts` (lcov vs that scope: diff line and branch %, global-drop check), `verify-state.ts` (`.h7/verify.json`, one record per bar layer: pass, fail, na with reason), `verify-gate.ts` (Stop hook that blocks while that record is incomplete; fails open on internal error, honors `stop_hook_active`, gives up after 5 blocks or 12 h; registered only from `/h7:work` and `/h7:ship` frontmatter).

`/h7:review` helpers (`plugins/h7/scripts/`): `review-lenses.ts` (verify-scope JSON in, `selected[]` and `skipped[]` out, every lens with a reason; `--all` forces all), `models.ts` (`reviewer --author <model>` resolves the reviewer model from `~/.h7/models.json`, `H7_HOME` override, missing or corrupt file means unconfigured, never writes; `cli` lists `codex` and `gemini` on PATH, detection only), `review-findings.ts` (`merge` parses reviewer reports, drops findings without command or output, dedupes by command or by place and title, ranks by severity then agreeing lenses; `keep` selects the ids the parent reproduced). Reviewers are the read-only agents `plugins/h7/agents/review-<lens>.md` (tools `Read, Grep, Glob, Bash`, enforced by the skill linter). Per-run files in `.h7/review/`.

## Decisions

| # | Area | Decision |
|---|---|---|
| 1 | Harness | Claude Code first-class (hooks, subagents, plugin). Skills stay Agent-Skills-spec-portable so Cursor/Codex can read SKILL.md text. |
| 2 | pstack | Borrow patterns, write own skills. Port real code (watch-pr, check-plan) with MIT attribution. mattpocock/skills stays an external dependency. |
| 3 | Sync | Repo is a plugin marketplace (`h7kz`) with one plugin `h7`. No `version` in manifest (commit SHA = version). Authoring machine adds marketplace from the local dir (live). Other machines add `H7KZ/Agents` with `autoUpdate: true`. Bootstrap (`install.ps1` / `install.sh`) wires it, installs mattpocock from `claude-plugins-official`, removes stale duplicates. |
| 4 | Per-repo state | Committed in each target repo, written by `/h7:setup`: `docs/agents/verification.md`, `.claude/skills/verify-<app>/` (recipe + feature map), `AGENTS.md` section (principles, rule↔enforcer table, commands), `CLAUDE.md` containing `@AGENTS.md`. |
| 5 | Invocation | Driver `/h7:work` + standalone phase skills. All h7 skills `disable-model-invocation: true`; nothing auto-triggers. The driver loads phase skills by reading `${CLAUDE_PLUGIN_ROOT}/skills/<phase>/SKILL.md` (model cannot invoke user-only skills). |
| 6 | Hooks | (a) Global safety guard (PreToolUse, always on). (b) Verification Stop gate registered by `/h7:work` and `/h7:ship` frontmatter only. (c) No global format-on-edit. Rules only, no LLM judge; near-misses logged (secrets redacted) for promotion. Guard internal errors or unresolvable targets (brace/variable expansion) fail to *ask*, never allow. The guard is a safety floor against agent accidents, not a sandbox: git failures and indirection (pipes into shells, xargs, iex, variable command words, aliases) ask; only clearly destructive, resolvable cases block. Ask mode per machine (`H7_GUARD_ASK` env or `~/.h7/guard.json` `{"ask": "prompt"|"allow"|"deny"}`): `allow` for fully autonomous machines (blocks still block), `deny` turns asks into blocks. `~/.h7` is owner-only: file tools resolving into it and shell commands naming it block. Threat model: accidents, not a malicious agent (one could still disable the plugin in settings.json); shell-text matching is best-effort by design. |
| 7 | Testing bar | Scope = what the change touches, never the whole repo. All layers that suit the work: lint, types, unit, 100% diff line+branch coverage with no global drop, mutation ≥80% on changed files every run, written edge-case matrix, property-based, e2e via the repo verify skill, Bombadil for web/TUI, regression test per bug (committed failing first). Each layer passes or is N/A with a reason. Thresholds overridable in `verification.md`. |
| 8 | Repo memory | `AGENTS.md` (≤150 lines, always loaded), `CONTEXT.md` (domain glossary), `docs/adr/`, run journal `.h7/runs/YYYY-MM-DD-<slug>.md` excluded via `.git/info/exclude` (local only). |
| 9 | Formal verification | Proposed by the driver when the change touches concurrency, ordering, multi-device state, state machines or invariant-heavy algorithms; user decides. Each check records covered files + sync commit, must be shown failing on a broken variant, TLA+ results rendered as statecharts. Toolchain on demand. |
| 10 | Review | Fresh-context subagent reviewers, one lens each: spec, standards, adversarial, security, performance, test quality, architecture/simplicity. Driver picks relevant lenses and logs skips. Finding survives only with command + output the parent reruns. Reviewer model ≠ author model (per-machine model-roles config). Optional cross-vendor reviewer if `codex`/`gemini` is installed, used only after asking (the diff leaves the machine). Reviewer model comes from `~/.h7/models.json` `reviewer`; if unset or equal to the author the driver asks and logs "not independent". |
| 11 | Loop termination | Done = all bar layers pass/N-A, zero proven findings, no open user decisions, full local check suite green. Predicate never relaxed (weakening a test is a user decision). Brake: 5 consecutive non-improving rounds → stop and report. |
| 12 | Ship | Ship mode per repo (`pr` / `push`), overridable per run. Repo's commit convention, else Conventional Commits. PR body: Why / What changed / Scope / Blast radius / Verification / Review / Decisions. CI watcher CLI (GitHub only for now, verdict model provider-agnostic): READY / WAITING / BLOCKED with blocker kinds; triage flake (1 rerun) vs stale base vs real failure. Never merges unless the repo opts in. |
| 13 | Runtime | Hooks and CLIs in TypeScript run by Node ≥22.18 type stripping, zero dependencies, tests on `node:test`. This repo has CI on windows/macos/ubuntu. |
| 14 | Learning loop | `/h7:retro`: proposes checks for the target repo (architecture → types → lint → test → prose), each proven against a real past mistake, user approves row by row, separate commits. h7 improvements queue in `~/.h7/proposals/`; `/h7:improve` in this repo drafts them, user approves. |
| 15 | Build order | foundation → setup → verify → review → ship → driver → learning. First real target: PortfolioV7. |

## Repo layout

```
.claude-plugin/marketplace.json     marketplace "h7kz" → plugins/h7
plugins/h7/
  .claude-plugin/plugin.json        name "h7", no version
  skills/<name>/SKILL.md            phase skills (+ references/, scripts/)
  agents/*.md                       reviewer subagents
  hooks/hooks.json                  global hooks (safety guard)
  scripts/*.ts                      hook + CLI implementations
  test/                             node:test suites
bootstrap/install.ps1, install.sh   machine setup
scripts/                            repo tooling (skill linter, …)
docs/design.md, docs/adr/, docs/research/
.github/workflows/ci.yml            3-OS CI
AGENTS.md, CLAUDE.md                rules for agents working on this repo
```

## Per-machine state (never committed)

- `~/.h7/models.json`: role → model (author, reviewer, verifier, cheap worker). Skills fall back to defaults.
- `~/.h7/proposals/`: improvement queue.
- `~/.h7/guard.log`: safety-guard near-misses.
