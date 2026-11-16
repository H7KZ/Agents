---
name: setup
description: Interview this repo (not the user) and write its committed agent state - docs/agents/verification.md, an h7 block in AGENTS.md, CLAUDE.md importing AGENTS.md, and a proven verify-<app> skill with a feature map - then report test-layer gaps. Re-run to update.
disable-model-invocation: true
---

# h7 setup

Run inside the target repo. Detect, run, write, prove, report.

## Hard rules

1. Interview the repo, not the user. Ask only: ship mode, auto-merge opt-in, and what detection cannot settle (AskUserQuestion).
2. Every command written to `docs/agents/verification.md` is one you ran successfully this session. Otherwise mark it `UNVERIFIED: <why>` or `GAP: <what is missing>`. Never guess a command, tool or threshold.
3. Install no tooling. Missing layers are gaps; `/h7:verify` fills them later with user approval. Installing the repo's own declared dependencies (`<pm> install --frozen-lockfile`) is allowed.
4. Never run commands whose script `kind` is `deploy`, nor anything that publishes, migrates, seeds or touches real services. Never read or write `.env` files or secrets.
5. The verify skill must be proven end to end once (launch, drive one feature, evidence, cleanup). If it cannot be, report `BLOCKED` with exactly what the user must provide. Never fake a proof.
6. Never edit outside the h7 markers in AGENTS.md, and never grow AGENTS.md past 150 lines. Use `setup-files.ts` for AGENTS.md, CLAUDE.md and the exclude file; do not hand-edit them. Run it from the repo root with repo-relative paths; it refuses symlinks and paths outside the repo (report that to the user, e.g. a linked worktree's shared exclude file).
7. Work on branch `h7/setup`, never on the default or a protected branch. Never push.

## Workspace mode (team repos where h7 is only your workflow)

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.ts" show`. If `mode` is `workspace` (a `.h7-workspace.json` above this repo lists it; `/h7:doctor` validates it), nothing of h7 may land in the repo, not even git-excluded files. The rules above hold with these substitutions; detection still runs against the repo, read-only:

- No branch `h7/setup`, no `git switch`, no commits, no `.git/info/exclude` edit. A dirty tree is fine (nothing in it is touched).
- `.h7/...` means the printed `stateDir` (outside the repo), including `detect.json`, `agents-block.md`, `setup-log.md` and `evidence/`.
- The recipe goes to the `verification` path from `show` (default `<ws>/docs/agents/verification-<repo>.md`), not `docs/agents/verification.md`.
- The verify skill goes to `<ws>/.claude/skills/verify-<repo>/SKILL.md` (a monorepo: `verify-<repo>-<app>`), not into the repo.
- The AGENTS block goes into `memory.agents` (the workspace `AGENTS.md`), 150-line cap unchanged; the repo's own `AGENTS.md` and `CLAUDE.md` are never touched. Run `setup-files.ts` with cwd set to the workspace root and workspace-relative paths.
- Repo memory names: the glossary is `memory.glossary` from `show` (`CONTEXT.md`, or `GLOSSARY.md` when that is the one that exists).
- Report "workspace mode, nothing written inside the repo" and verify it: `git status --short --ignored` in the repo shows no h7 file.

A malformed marker is an error: stop and show it. The marker's `ship` and `autoMerge` are the answers to the ship questions; do not ask again, and say when they are ignored because the marker is not yet trusted (the user runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.ts" trust` in a terminal).

## 1. Prepare

1. `git status --short`. If dirty, stop and report; do not stash or reset.
2. `git switch -c h7/setup` (or `git switch h7/setup` if it exists).
3. Keep `.h7/` out of git, then detect (use the exclude path from a prior run, else `.git/info/exclude`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-files.ts" exclude .git/info/exclude --write
mkdir -p .h7
node "${CLAUDE_PLUGIN_ROOT}/scripts/detect.ts" . > .h7/detect.json
```

4. Read `.h7/detect.json`. Fields: `languages`, `packageManagers`, `monorepo`, `scripts` (with `kind`, `run`, `mutates`), `tools`, `layers` (`status` found, gap or na, with `tools`, `commands`, `recommend`), `surfaces` (`kind`, `dir`, `run`), `ci` (`jobs[].commands`, `triggers`), `docs`, `git`, `gaps`, `warnings`. Anything missing is a gap, not a guess.
5. If `docs.verificationMd` or `docs.agentsMd.hasH7Block` is true, this is an update: see "Re-running".

## 2. Ask

One AskUserQuestion call, only for what detection cannot settle:

- Ship mode: `pr` or `push`. Suggest `pr` when `git.protectedBranches` is non-empty.
- Auto-merge when CI is green: default off.
- Any `gaps` entry of kind `default-branch`, or a runnable surface with no derivable run command.

Ship mode and auto-merge are asked once per repo; on update, keep the recorded answers unless the user changes them.

## 3. Verify the commands

Run each candidate from `layers[].commands` and the install command. Pick, per layer, the command CI runs (match `ci.jobs[].commands`) over a local script when both exist.

- Run non-mutating commands only (`mutates: false`). Use the format check, not the formatter.
- Time-box every command (`timeout 300`, or the shell's equivalent); a command that hangs or exceeds it is `UNVERIFIED: did not finish in <n> s`. If dependencies are already installed and the install command hangs, mark it UNVERIFIED instead of waiting.
- A cached result (turbo, nx) is not a run: rerun with the cache bypassed (`--force`) or record `verified (cache hit)`.
- Format check failing on many files: run `git ls-files --eol`; `w/crlf` against `i/lf` is a Windows checkout artifact. Record it as FAILING with that note; do not reformat.
- Interpreter names differ per OS (`python3` on Windows may be a Store stub that hangs): try `py` or `python`, and record the form that worked and the form CI uses.
- Time-box applies to the slowest first: about 5 minutes at most. A command that needs a service, secret or network you lack is `UNVERIFIED: <why>`.
- Record exit code and one line of output per command in `.h7/setup-log.md`.
- Failing command: do not fix the repo. Record `FAILING: <first error line>` and report it.
- Full local check = the commands CI runs on pull requests (`ci.triggers` with `pull_request`), minus deploy and secret-dependent jobs. If a repo script already wraps them (`kind: check`), prefer it.
- Diff coverage: use the repo's tool if `tools` has `diff-cover`; otherwise `GAP: no diff-coverage command`.
- Mutation on changed files: needs a tool that accepts a file list (Stryker `--mutate`, mutmut `--paths-to-mutate`, cargo-mutants `--in-diff`); otherwise `GAP`.

## 4. Write `docs/agents/verification.md`

Fill [the verification template](references/verification.template.md). Keep every status marker. Thresholds default to the h7 testing bar (100% diff line and branch coverage, no global drop, mutation at least 80% on changed files); change them only if the repo already enforces others. Layers that do not apply get an N/A reason, e.g. "no runnable app surface". Commit it:

```
git add docs/agents/verification.md && git commit -m "docs: add agent verification recipe"
```

Use the repo's commit convention (`git.commitConvention`), else Conventional Commits. End commit messages with the attribution trailer the session instructs.

## 5. AGENTS.md, CLAUDE.md

1. Fill [the AGENTS block template](references/agents-block.template.md) into `.h7/agents-block.md`. The Rule <-> enforcer table is seeded from what the repo already enforces (lint, type, format, test, CI configs). Rules the repo states but nothing enforces get enforcer `none yet`. Copy rules from the existing AGENTS.md or CLAUDE.md; do not invent any.
2. Plan, then write:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-files.ts" agents AGENTS.md .h7/agents-block.md
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-files.ts" agents AGENTS.md .h7/agents-block.md --write
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-files.ts" claude CLAUDE.md --write
```

The first call only plans. Statuses: `created`, `appended`, `unchanged` are safe to write. `differs`: the block was changed since last run; show the diff between `existing` and your new block, ask before `--replace --write`. `oversize`: AGENTS.md would pass 150 lines; do not write, report the line count, and put the block in `docs/agents/h7.md` instead with one pointer line the user approves.
3. If the repo has a formatter, run its check on the written files and let it fix only those files. If it rewrites the h7 block, copy the formatted block back into `.h7/agents-block.md` and plan again; the status must be `unchanged`, or the next run reports `differs`.
4. Commit AGENTS.md and CLAUDE.md.

## 6. Verify skills

For each `surfaces[]` with `kind` web, api, cli or desktop (skip `library`, mark N/A):

1. Read the app's entry points and, for tests, any existing Playwright, Cypress, PTY or HTTP harness. Reuse the repo's own driver first; add a new one only if none exists.
2. Write `.claude/skills/verify-<app>/SKILL.md` from [the verify skill template](references/verify-skill.template.md). Sections in order: Launch, Doctor, Drive, Evidence, Cleanup, Helpers. Each states a checkable end condition. Launch starts from empty state (empty data dir, fresh database or seed) and "ready" means usable, not "port open".
3. Write `features/README.md` from [the feature map README](references/feature-map-readme.template.md) and one `features/<feature>.md` per user-facing feature from [the feature template](references/feature.template.md). Exactly four H2s per feature file: `Sub-features`, `How to get to it (user POV)`, `Driving it`, `Gotchas`. Find features by reading routes, pages, commands, handlers; list real selectors and commands.
4. Put executable helpers under the skill's `scripts/` and show their invocation.

In a monorepo, one skill per app, each under the repo root `.claude/skills/`.

## 7. Prove it

Follow your own verify skill, literally, once:

1. Launch from empty state. Run Doctor. Drive one feature through its real user path. Save evidence (action, resulting state, side effects, screenshots or command output) under `.h7/evidence/<app>/`. Cleanup: kill only processes you started; evidence must survive.
2. Fix the skill where the run showed it wrong, then rerun until it passes once cleanly.
3. If you cannot, stop at the blocker and report `BLOCKED: <what the user must provide>` (a secret, a database, a service, a browser binary). Mark the skill header `Status: UNPROVEN - <blocker>` so `/h7:verify` knows.
4. Commit the skills: `git add .claude/skills && git commit`.

## 8. Report

Keep it short:

- Files written, with commit hashes. Branch name. Not pushed.
- Commands: verified, UNVERIFIED (why), FAILING, GAP.
- Verify skill proof: PROVEN or BLOCKED with the exact ask.
- Gap report: each `gaps` entry with the recommended tool for the stack. State that `/h7:verify` installs tooling after approval.
- Decisions you defaulted or recorded: ship mode, auto-merge.

## Re-running

Detect again, then regenerate every file to `.h7/` and compare with what is committed. Overwrite nothing silently: show each diff, ask per file when the committed copy differs from the last generated one (hand edits), and never touch content outside the h7 markers. Re-prove a verify skill only if its app's run or feature files changed.
