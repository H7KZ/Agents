---
name: retro
description: Turn the corrections and failures of recent work (run journals in .h7/runs plus this session) into proposed checks, each a concrete Rule <-> enforcer table row proven against a real past mistake, strongest enforcer first (architecture, types, lint, test, prose last). The user approves row by row; only approved rows are written to the repo's table, one commit per row. Never adds a rule unasked or unproven.
disable-model-invocation: true
---

# h7 retro

`/h7:retro` makes each real mistake harder to repeat. Run inside the target repo, on a feature branch (never the default branch). It proposes; the user decides; nothing is written to the repo before a yes for that row.

## Hard rules

1. A row exists only for a mistake that really happened: a journal event, a revert or fix commit, a review finding that was kept, or a correction the user made in this session. Every row cites that evidence. No evidence, no row.
2. Fix at the highest level that can catch it: architecture (make the mistake unrepresentable), then types, then lint or CI check, then a test, and prose (a rule in AGENTS.md or a skill) only for judgment a machine cannot check. A prose row needs a sentence on why nothing stronger fits.
3. Never write a row on your own. `apply` runs only for ids the user approved in this session, named on the command line. Never approve in bulk, never "apply all", never treat silence as yes. A rejected row stays rejected.
4. A check must be able to fail: before proposing a lint rule, type setting or test, run it against the past mistake (the reverted code, the commit before the fix) and see it fail, then see it pass on the fixed code. The command and output go in the row's evidence. A check you could not make fail is a prose row or no row.
5. Never weaken an existing check, delete a rule or touch a threshold. Retro only adds. Never read `.env` files. Never push.
6. Rows and journals are local state: `.h7/` is git-excluded, never committed, never quoted into a commit message beyond the row text. Put no secrets in rows; the script redacts, but do not rely on it.
7. Installing a tool or dependency for a proposed check needs its own yes (name, why, the exact command).

## 1. Collect

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/retro-rows.ts" signals --limit 5
```

It prints, for the newest runs under `.h7/runs`, the task, verify failures (layers that failed), unresolved proven findings, rounds that did not improve, `decision` events and `note` events. Corrupt journal lines are counted and skipped. No runs is fine: use the session alone.

Add what the journals cannot show:

- This session: where the user corrected you, rejected a plan, or repeated an instruction. Quote it in your own words, with what you did wrong.
- History: `git log --oneline -n 50`, then commits whose subject starts with `fix` or `revert`, and `git log -S` or `git blame` on what they changed. A bug fixed twice in the same area is a class, not an accident.
- The existing table in `AGENTS.md` (the Rule <-> enforcer section): a rule listed as `none yet` that was broken again is the first candidate to give an enforcer.

Group findings into mistake classes. One occurrence is enough when the harm was real (a leaked secret, lost data, a broken main); otherwise prefer classes seen twice.

## 2. Draft rows

For each class, decide the strongest enforcer that exists or could exist in this repo (read its lint, type, test and CI config first; reuse the tools it already has). Draft one row per class:

| Field | Content |
|---|---|
| `rule` | The rule in one sentence, written as what must hold, not as a wish. |
| `enforcer` | The concrete thing that fails: a test file, lint rule, type setting, CI job, or `none yet` only for a prose row. |
| `kind` | `architecture`, `types`, `lint`, `test` or `prose`. |
| `evidence` | The past mistake: run id and event, commit hash, finding id, or the session correction, plus the command that fails on it. |

Each cell is one line of at most 300 characters. If a check needs code (a lint rule, a test), build it now on the feature branch with the failing-first discipline of `/h7:work` step 3 and keep it in its own commit with its row; do not leave a row pointing at a check that does not exist.

Store the draft:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/retro-rows.ts" propose '<json array of rows>'
```

On PowerShell pass the JSON on stdin: `'[...]' | node "<script>" propose -`. The script validates all rows or none, redacts, and numbers them `r1`, `r2`, ... A rule already proposed (same words, any case) comes back under `duplicates`. `list` shows the rows and their status.

## 3. Ask, row by row

For each pending row show: id, rule, enforcer, kind, evidence, and what the check costs (a new dev dependency, CI time, false-positive risk). Ask with one AskUserQuestion per row or a batch with one question per row: `approve`, `reject`, or `change` (the user's wording replaces yours, then ask again). Recommend, but the user decides.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/retro-rows.ts" reject r2 r4
```

Say what happens to rejected rows: they are not proposed again. Rows the user defers stay `pending`.

## 4. Apply the approved rows

Dry run first, per approved row, so the user sees the table change:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/retro-rows.ts" apply r1
node "${CLAUDE_PLUGIN_ROOT}/scripts/retro-rows.ts" apply r1 --write
```

Without `--write` nothing changes. The script writes only into the Rule <-> enforcer table of `AGENTS.md` (or `--file <path>`), keeps everything else byte for byte, refuses symlinks and paths outside the repo, writes atomically, and refuses to grow `AGENTS.md` past 150 lines (exit 1, `oversize`: tell the user and propose moving detail into `docs/agents/verification.md` with `--file docs/agents/verification.md --create`, never trim other rules). Exit 1 with `no-table` means the file has no Rule <-> enforcer section: suggest `/h7:setup`, or `--create` for the verification doc.

Commit each approved row separately, with the check it points at when you built one:

```
git add <explicit paths>
git commit -m "docs(rules): <rule in a few words>"
```

Use the repo's commit convention, else Conventional Commits, with the attribution trailer the session instructs. Each commit passes the repo's full local check first (`docs/agents/verification.md`). Never push; shipping is `/h7:ship`.

## 5. Report

Brief: the runs and history read, the classes found, and per row its id, kind, decision (applied, rejected, deferred) and commit hash. Name the rows that are `prose` and have no enforcer yet, and any class you could not turn into a failing check, so the user knows what is still unguarded. If `improve` material came up (a gap in h7 itself, not in this repo), tell the user it belongs in `/h7:improve`; do not edit h7 from here.
