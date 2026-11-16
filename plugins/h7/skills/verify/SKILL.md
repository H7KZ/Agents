---
name: verify
description: Run every testing layer of the h7 bar scoped to the current change vs its base - lint, types, unit, 100% diff line and branch coverage with no global drop, mutation at least 80% on changed files, written edge-case matrix, property tests, e2e via the repo verify skill, Bombadil for web or TUI, failing-first regression tests. Each layer passes or is N/A with a reason. Installs missing tooling only after asking.
disable-model-invocation: true
---

# h7 verify

Run inside the target repo, on a feature branch. Scope = what the change touches, never the whole repo. Evidence replaces line-by-line review, so a layer is `pass` only with a command and its output.

## Hard rules

1. Commands come from `docs/agents/verification.md` (written by `/h7:setup`). Never guess one. A command marked `UNVERIFIED` or `GAP` is a gap to fill (step 2), not something to skip.
2. Install nothing without asking. Missing tooling: one AskUserQuestion naming the tool, why, and the exact install command; install only on yes. Never `curl | sh`; prefer the repo's package manager and pin the version it resolves.
3. Never weaken the bar to pass: no skipped or deleted tests, no lowered thresholds, no coverage-ignore pragmas, no mutant exclusions unless the user decides it. A threshold is lowered only where `verification.md` already says so.
4. Never run deploy, publish, migrate or seed commands, and never read `.env` files.
5. Never push. Commits follow the repo convention (`git.commitConvention`), else Conventional Commits, with the attribution trailer the session instructs.
6. Record every layer; the Stop gate reads the record (step 1). A layer is `pass`, `fail` or `na` (with a reason). Never leave one `pending`.

## 1. Scope and state

```
mkdir -p .h7
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-scope.ts" > .h7/scope.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-state.ts" init
```

`scope.json` lists `warnings[]` (read them: for example no merge base) and `files[]` (`path`, `kind` source, test or other, changed `ranges`, `whole` for untracked files) against the merge base with the default branch. Pass `--base <ref>` when the default branch is not `main` or `master`. Keep `.h7/` out of git (`/h7:setup` does this). If there are no source changes, mark every layer `na` with "no source change" and stop.

Record each layer as you finish it. Every status needs one line of evidence or reason (the command and its result); the CLI refuses a bare `pass` and the gate treats one as incomplete:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-state.ts" set <layer> <pass|fail|na> <one line of evidence or reason>
```

Layers: `lint`, `types`, `unit`, `diff-coverage`, `mutation`, `edge-cases`, `property`, `e2e`, `bombadil`, `regression`. `node ".../verify-state.ts" check` prints what is left; exit 1 means incomplete.

Thresholds: defaults below; read overrides from the Thresholds section of `verification.md`.

## 2. Tooling gaps

List the layers whose command is a `GAP` or whose tool is missing. Ask once (rule 2) for all of them, recommending the stack's usual tool:

- Diff coverage: a coverage reporter that writes lcov. Node: `node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=lcov.info`. Others: the runner's lcov output (`c8`, `vitest --coverage --coverage.reporter=lcov`, `coverage.py` plus `coverage lcov`, `cargo llvm-cov --lcov`).
- Mutation with a file list: Stryker (`--mutate`), mutmut (`--paths-to-mutate`), cargo-mutants (`--in-diff`), PIT.
- Property tests: fast-check (JS, TS), Hypothesis (Python), proptest (Rust), jqwik (JVM).
- Bombadil, only for a web or TUI surface.

On decline, the layer is `fail` with "tool not installed (declined)", never `na`: N/A means the layer does not apply to this change, not that it is inconvenient. Record installed tools in `verification.md` and commit that with the tooling.

## 3. Static and unit

1. `lint`, `types`: run the recorded commands on the whole repo (they are cheap and global by nature). Fix failures caused by the change.
2. `unit`: run the recorded command. Failing tests caused by the change are fixed in the code, not the test, unless the test is provably wrong (then say so in the commit).

## 4. Diff coverage (100% line and branch, no global drop)

1. Produce lcov for the full unit run (the report must include the changed files).
2. For the global-drop check, produce a baseline report from the merge base in a throwaway worktree: `git worktree add ../h7-base <mergeBase>`, run the coverage command there, copy its lcov out, then `git worktree remove ../h7-base`. If the baseline cannot be produced, say so and compare against the last baseline recorded in `verification.md`, else `fail` with the reason.
3. Measure:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/diff-coverage.ts" --lcov lcov.info --scope .h7/scope.json --baseline baseline.lcov
```

Add `--lines <pct> --branches <pct>` only for overrides from `verification.md`. Exit 0 passes; 2 is an error (for example two coverage records match one path: fix the report or its path prefix); 1 fails, with `unmeasured` listing changed source that has no instrumented line or branch in its changed range, or no changed source at all (nothing proves coverage, so it fails). Use `--allow-unmeasured` only when the lines are types, comments or configuration, and say so in the evidence. A failure prints `files[]` with `uncoveredLines`, `uncoveredBranches` and `missing` (a changed source file absent from the report). Write tests that exercise each listed line and branch. Never exclude code from coverage to pass. Lines the tool cannot see, such as a thin entry guard, need a subprocess test.
4. Platform independence: do not add code whose branches only one OS runs, unless a test for each side exists.

## 5. Mutation (at least 80% on changed files, every run)

Run the mutation tool restricted to the changed source files (`scope.json`, `kind: source`), using the recorded command or the tool's file-list or diff option. Never run the whole repo. Score under the threshold: read the surviving mutants, add or strengthen tests that kill them, rerun. A survivor that is semantically equivalent is listed in the report with a one-line argument; it is not excluded in config unless the user agrees. A run too slow to finish is `fail` with the timing, not `na`.

## 6. Edge-case matrix (written)

Write `.h7/edge-cases.md` for the change, a table `case | why it matters | test`. Walk these axes and keep only those that apply, each with a reason for skipping: empty, zero, one, many, maximum; boundaries and off-by-one; invalid, malformed, hostile input; unicode, whitespace, case, locale; time (zones, DST, ordering); concurrency and re-entry; partial failure and retries; resource limits; permissions; platform differences (paths, line endings); backwards compatibility. Every row names a test that exists and passes, or `UNTESTED: <why>`. Any `UNTESTED` row without a reason, or an empty matrix for a nontrivial change, is `fail`.

## 7. Property tests

For each pure function, parser, serializer, state machine or invariant the change touches, add or reuse a property test: round trips, idempotence, ordering, "never throws on any input", model against a simple reference. Seed and shrinking output go in the evidence. `na` only with a reason such as "change is configuration and prose only".

## 8. E2E via the repo verify skill

For a change that reaches a runnable surface, follow `.claude/skills/verify-<app>/SKILL.md` (path from `verification.md`) literally: Launch, Doctor, Drive each affected feature through its real user path, Evidence under `.h7/evidence/<app>/`, Cleanup. Find affected features from `features/README.md` and the diff. A skill marked `Status: UNPROVEN` is a blocker: report what the user must provide and mark `e2e` `fail`. No runnable surface (library, scripts only): `na` with that reason, but then the unit and property layers must exercise the public entry points.

## 9. Bombadil (web or TUI surfaces)

For a web or TUI surface, run Bombadil property-based exploration against the launched app (recipe from the verify skill's Launch). Properties are the repo's invariants (no uncaught errors, no dead ends, state stays consistent), written next to the e2e specs and committed. Failures found become regression tests (step 10). No web or TUI surface: `na` with that reason.

## 10. Regression tests, failing first

Every bug fixed in this change (found by any layer, or the task itself) gets a regression test committed before the fix:

1. Commit the test alone; run it and show it failing for the bug's reason (`test(<scope>): reproduce <bug>`).
2. Commit the fix; show the test passing.
3. Evidence is the two commit hashes plus the failing and passing output. `na` only for a change that fixes no bug and found none, with that stated.

## 11. Report

Run `verify-state.ts check`, then report briefly:

- Table: layer, status, evidence or N/A reason (one line each).
- Diff coverage numbers, mutation score, surviving mutants argued equivalent.
- Gaps and tools installed or declined.
- Failing layers with the first actionable error. Do not claim done while any layer fails; hand back to the caller's loop.

## Stop gate

`/h7:work` and `/h7:ship` register the gate in their own frontmatter, never globally and never in `/h7:verify`:

```yaml
hooks:
  Stop:
    - hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/verify-gate.ts"]
```

It blocks stopping while `.h7/verify.json` has a `pending` or `fail` layer, or an `na` without a reason. It allows when `stop_hook_active` is set, after 5 blocks, for a state older than 12 hours, and on any internal error. Delete `.h7/verify.json` to abandon a run.
