---
name: work
description: Drive a task end to end - research, grill the user on the plan (only real decisions), implement failing-test-first in staged commits, verify, review, loop until the done predicate holds, then ship. Loads the phase skills by reading their files, keeps an append-only redacted run journal in .h7/runs, and stops after 5 non-improving rounds to report. Supports an unattended mode (pre-flight batch, park what needs a human, never idle-wait). Never relaxes the done predicate. Registers the verification Stop gate.
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/verify-gate.ts"]
---

# h7 work

`/h7:work <task>` drives one task from request to a watched pull request. Run inside the target repo, on a feature branch (create one with `git switch -c <name>`; never work on the default branch). The task is the text after the command; ask for it if empty.

The Stop gate in the frontmatter blocks stopping while `.h7/verify.json` has a `pending` or `fail` layer. When it blocks, continue the loop (step 5); do not edit the state file to get past it. To abandon the run on purpose, tell the user; they delete `.h7/verify.json`.

## Hard rules

1. The done predicate is never relaxed: every verify layer `pass` or `na` with a reason, zero proven review findings, no open user decision, the repo's full local check green. Weakening a test, lowering a threshold, skipping a layer or dropping a finding is a user decision, asked and journaled, never yours.
2. Load phase skills by reading the phase file under `${CLAUDE_PLUGIN_ROOT}/skills/` (verify, review, ship) with the Read tool and following it. Never try to invoke an h7 skill through the Skill tool (they are user-only), and never paraphrase a phase from memory.
3. Ask the user only for real decisions: a choice between alternatives that change behaviour, scope, public contracts or cost, or an action the phase skills say needs a yes. Anything the code, docs, tests or a run can answer, answer yourself and journal it.
4. Never push, merge or open a pull request unless `/h7:ship` rules allow it (the user asked for this run, or `docs/agents/verification.md` records the ship mode). Shipping is step 6 and follows `/h7:ship` literally.
5. The journal is local state: `.h7/` is git-excluded and never committed, never staged, never quoted into a commit message, PR body or comment beyond what a phase skill asks for. Put no secrets in it; the script redacts, but do not rely on it.
6. Never read `.env` files. Commits follow the repo convention, else Conventional Commits, with the attribution trailer the session instructs, `git add <explicit paths>` only. The safety guard applies to every call; when it asks, ask the user.
7. Unattended runs (see Unattended mode) never wait on a human and never weaken anything: a block, deny or need is parked, not bypassed.
8. Stop after 5 consecutive non-improving rounds (step 5, counted by `run-journal.ts progress`, not by you) and report. Do not start a sixth.

## Workspace mode

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.ts" show` first. When `mode` is `workspace` (a `.h7-workspace.json` above the repo lists it), `.h7/` below means the printed `stateDir` (outside the repo: the journal, `verify.json`, `review/`, `ci-watch.json`; the scripts resolve it themselves and never write `.h7/` or `.git/info/exclude` in the repo), the recipe is the printed `verification` file, the base branch is the printed `base`, memory files are the printed `memory.*` paths, and the phase skills follow the same substitution. A malformed marker is an error: stop and show it. A marker that is not `trusted` still gives paths and base, but its scratch dir, push and auto-merge are ignored: tell the user to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.ts" trust` in your own terminal (the user, never the agent; the guard blocks it). In repo mode nothing changes.

## 0. Start or resume

1. Read `docs/agents/verification.md` (the check command, thresholds, ship mode). Missing: tell the user `/h7:setup` writes it, and continue only if they want to; verify and ship will then ask for what they need.
2. Resume an unfinished run when the user says so or `.h7/runs/` holds one for this task; otherwise start a new one:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-journal.ts" start --task "<one line task>"        # add --unattended when the user will be away (step 2)
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-journal.ts" show
```

`start` first adds `.h7/` to the repository's `info/exclude` (the path comes from `git rev-parse --git-path info/exclude`, so a linked worktree works) and writes nothing at all when it cannot, then creates `.h7/runs/<id>/journal.jsonl` and records the id in `.h7/runs/CURRENT`. Keep the `id` it prints and pass `--run <id>` on every later call: `CURRENT` is shared by every session in the repo, a second `start` replaces it, and with no `--run` and no `CURRENT` the script refuses to pick between several runs. `show` (with no `--run`, it reads CURRENT; take the id from its output when resuming) gives event counts per phase and the last events: continue from the phase the last event shows. A task text of `resume <id>` resumes that run with `--run <id>`; an unattended run stays unattended (a later `start` inherits the flag, and the guard reads it from the journal).

## Journal

Append one event at each phase transition, decision, verification result and review result. Phases: `research`, `grill`, `implement`, `verify`, `review`, `loop`, `ship`, `decision`, `note`. The data is a JSON object; keep it short and factual (what, result, evidence), never raw logs or file contents.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-journal.ts" append --run <id> <phase> '<json>'
```

On PowerShell pass the JSON on stdin instead, with the same script path as above (`${CLAUDE_PLUGIN_ROOT}` is substituted by the plugin when this skill loads) and your own phase name where `<phase>` stands: `'{"a":1}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/run-journal.ts" append --run <id> <phase> -`. The script redacts URL credentials, tokens, `NAME_TOKEN=` assignments, flag values and any value under a secret-looking key, caps sizes, refuses symlinks and hardlinked files, and appends one whole line. It also rejects a `loop`, `verify` or `review` event whose `failing` or `unresolved` is missing, negative, fractional or a string (an array counts by length): fix the JSON and append again, never leave a count out to make a round look better. Limit: a path swapped for a link between the script's checks and its open is not caught; h7 guards against accidents, not a hostile process in the same repo. Lines are never edited; a correction is a new event. A corrupt line costs only itself.

Events the loop relies on. Only `loop` events are scored; the others are the record the numbers come from:

| Phase | Data |
|---|---|
| `verify` | `{"failing": <count of layers not pass or na>, "layers": ["unit: failing (...)"]}` from `verify-state.ts check` (its `incomplete` list) |
| `review` | `{"unresolved": <proven findings not yet fixed>, "ids": ["F1"], "skipped": ["lens: reason"], "reviewer": "<model>", "independent": true}` |
| `loop` | `{"round": <n>, "failing": <n>, "unresolved": <n>}`, closes a round; both counts are required |
| `park` | `{"need": "what a human must provide or decide", "why": "what was blocked", "tried": "..."}` via `run-journal.ts park --run <id> '<json>'`; counted by `progress` as `parked`, listed by `show` |
| `decision` | `{"question": "...", "choice": "...", "why": "...", "adr": "docs/adr/NNNN-x.md"}` (adr when one was written) |

## 1. Research

Journal `research` with the task. Gather what the plan needs from the repo: read `AGENTS.md`, `CONTEXT.md`, `docs/adr/`, `docs/agents/verification.md`, the code and tests the task touches, recent history of those files (`git log --oneline -- <path>`), and callers (Grep). For an unfamiliar library, API or external fact use the `mattpocock-skills:research` skill when installed, else the docs tools; cite sources. Write nothing to the repo for research unless the user wants notes kept (`docs/research/`).

End with cited notes in the conversation: what exists, what the task changes, what could break, which verify layers apply (web or TUI surface? state machine, concurrency or ordering? pure parsers?), and the questions only the user can answer.

## 2. Grill

Interrogate the plan with the user before writing code. Use the `mattpocock-skills:grilling` skill when installed (it ends with decisions, ADRs go through `mattpocock-skills:domain-modeling`), else do it yourself:

- Draft the plan: behaviour change, files and areas, test approach, commit story, what is out of scope.
- Ask one AskUserQuestion batch of real decisions only, each with the alternatives, your recommendation and the cost of being wrong. Skip anything you can settle by reading code or running something. If a quick run or prototype would answer a question (does the API behave so? does this approach fit?), build it throwaway, run it, then ask with the result.
- Propose formal verification (TLA+ or similar, decision 9 in `docs/design.md`) only when the change touches concurrency, ordering, multi-device state, a state machine or an invariant-heavy algorithm; the user decides.
- A decision that is hard to reverse, surprising without context, and a real trade-off becomes an ADR in `docs/adr/` (committed in its own commit).

### Pre-flight (before the user leaves)

In the same grill batch, collect every decision or permission the run is likely to need, so nothing stalls later: tool or dependency installs, which commands may run (build, test, migrate, deploy), ship mode (push, PR, auto-merge), risky operations (history rewrites, deletes, dirty-tree git), external services and credentials the user must set up. Then ask `Will you be away? (attended/unattended)`. Unattended: run `start --unattended` and journal the answers; anything the user did not pre-approve is parked later, not asked.

Journal each answer as `decision`, then `grill` with the agreed plan summary. If an answer changes the scope, restate the plan and get a yes before step 3. No open question may remain when implementation starts; a new one found later is asked then.

## 3. Implement

Journal `implement` `{"step": "start"}`. Build the change in staged commits that tell a story:

1. Failing first: for each behaviour or bug, write the test, run it, see it fail for the right reason, commit it alone (`test(<scope>): reproduce <bug>`) when it is a bug fix. Then the smallest code that passes it. Use the `mattpocock-skills:tdd` skill when installed, else red, green, refactor by hand.
2. Order: tooling and refactors that change no behaviour, then the behaviour change, then docs. Each commit passes the repo's full local check before it is made (`/h7:ship` step 3 proves it again).
3. Run the code as you go: execute the unit under change, the CLI or the app path, and look at real output before moving on. A thing you did not run is not done.
4. Keep inside the agreed scope. Unplanned findings become a `note` and a question, not a silent expansion.
5. Install nothing without asking; no deploy, publish, migrate or seed commands.

Journal `implement` `{"step": "done", "commits": ["<hash> <subject>"]}`.

## 4. Verify, then review

1. Journal `verify` `{"step": "start"}`. Read `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` and follow it fully for the whole change vs its base. Then:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-state.ts" check
```

Journal `verify` with `failing` and `layers` from its `incomplete` list (an empty list is `{"failing": 0, "layers": []}`). Fix failing layers before review when the failure is plain (a red test, a lint error); otherwise review runs once verify has run every layer.

2. Journal `review` `{"step": "start"}`. Read `${CLAUDE_PLUGIN_ROOT}/skills/review/SKILL.md` and follow it fully. Its `.h7/review/proven.json` `kept[]` lists proven findings. Journal `review` with `unresolved` (the kept findings not yet fixed), ids, skipped lenses and whether the reviewer was independent of the author model. A reviewer that was "not independent" stays a recorded fact the PR body repeats.

## 5. Loop

A round is one pass of step 4 plus fixes. Close it:

1. If verify has failing layers or review has proven findings, fix them: a failing test for each defect committed first, then the fix, each commit passing the check. Findings you believe are wrong stay open until the user decides; never drop one yourself.
2. Rerun the affected verify layers, and the review when code changed in a reviewed area (a fix that touches new files or behaviour gets a fresh review of that diff). Update the counts.
3. Journal `loop` `{"round": n, "failing": <layers still failing>, "unresolved": <findings still open>}`.
4. Ask the script, not your judgement:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-journal.ts" progress --run <id>
```

It prints `rounds[]` (each with `failing`, `unresolved`, `score` and `improving`), `streak`, `limit`, `stop`, `clean` and `reason`. A round improves only when its score (failing layers plus unresolved proven findings) is lower than the best score of all earlier rounds, or is zero, so oscillating does not help; the first round has nothing to beat and counts as non-improving unless it is already zero, so five stuck rounds in a row are five rounds. `--limit <n>` can only lower the limit, never raise it above 5. `progress` also reads `.h7/verify.json` and `.h7/review/proven.json` when they exist: `observed` shows what they say and `warnings[]` lists every disagreement with what you reported; `clean` is never true while there is a warning, so rerun verify and review rather than fixing the numbers. Exit 1 and `stop: true` mean 5 consecutive non-improving rounds: stop the loop, do not ship, go to the report (step 7) with what is failing, what was tried each round (from the journal) and what you suggest the user decides. Otherwise continue while the done predicate does not hold.

Done = rule 1 holds. Check it, do not assume it: `verify-state.ts check` exits 0, the last review reports zero unresolved proven findings, every `decision` is answered, and the repo's full local check command from `verification.md` passes on the head commit. `clean: true` from `progress` only says the counts are zero; the rest of the predicate still has to be checked. Anything short of it goes back to step 1.

## 6. Ship

When the done predicate holds, journal `ship` `{"step": "start"}`, read `${CLAUDE_PLUGIN_ROOT}/skills/ship/SKILL.md` and follow it literally: ship mode from `verification.md`, the PR body from the verify record and the review files, `ci-watch.ts` after publishing. Pull the Decisions section from the journal's `decision` events.

CI failures and review comments that need code re-enter the loop: fix in a new round (step 5, counted by the journal like any other), rerun the affected verify layers, then return to `/h7:ship` step 6. A blocker that is not yours to fix (`merge-gate`, an unauthenticated `gh`) is reported, not worked around. Journal `ship` with the verdict, the PR link and the last watcher result.

Without permission to push (the user did not ask and no mode is recorded), stop after `/h7:ship` step 3 and report the branch, commits, check result, PR body and the exact commands you would run.

## Unattended mode

Only when the run started with `--unattended` (the guard then also denies, instead of asking, what would need a prompt; it can only get stricter, never weaker). Rules:

1. Never idle-wait on a human: no AskUserQuestion, no waiting on a prompt. When a guard ask arrives as a deny, a hard block, a failing permission or a skill step that needs a human, record it: `run-journal.ts park --run <id> '{"need":"...","why":"..."}'`, then continue with independent work.
2. Hard guard blocks are never retried, rephrased or bypassed. Journal the block, choose another approach that stays inside the rules, or park it.
3. Nothing the user did not pre-approve in the pre-flight: no installs, no push, no merge, no deploy. Park it with the exact command.
4. When nothing else can proceed (or at the end), send a PushNotification if that tool is available, summarising the parked items and the state (rounds, failing layers, branch, commits). Then stop cleanly with the report (step 7), listing `show`'s parked items and the exact resume command: `/h7:work resume <id>`.

## 7. Report

Brief. Branch, commits (hash and subject), the verify table (layer, status, evidence), review (lenses run and skipped, reviewer independence, proven findings and their fixes), rounds used and the last `progress` output, decisions made, PR link and last CI verdict, and the run id (`.h7/runs/<id>`). Say plainly what is not done and why: stopped on stagnation (with the failing layers or findings), waiting on a user decision, not pushed, not reviewed independently. Never say done while the predicate does not hold, and never say shipped while the watcher verdict is anything but `READY`.
