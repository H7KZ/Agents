---
name: formal-create
description: Create a formal model (TLA+ checked with TLC, rendered as a statechart) for one stateful component whose breakage tests rarely reach - concurrency, ordering, multi-device state, state machines, invariant-heavy algorithms. Picks the strongest target, keeps each model step true to one atomic code step, proves every property can fail on a broken variant, records the covered source globs and the sync commit in model.json. Installs the toolchain only after asking. Opt-in; the user decides.
disable-model-invocation: true
---

# h7 formal-create

`/h7:formal-create [component]` builds one model under `docs/formal/<name>/` for a component of the target repo. Run inside that repo, on a feature branch. Formal checks are opt-in (decision 9 in `docs/design.md`): `/h7:work` may propose one, the user decides. Keeping an existing model honest is `/h7:formal-maintain`.

## Hard rules

1. True to the code. Each model step is one atomic step of the real code, and every step cites its file and function. A model that describes how the code should work, not how it does, proves nothing.
2. Able to fail. A property counts only after you have shown it failing on a deliberately broken variant of the model (drop a guard, reorder two steps, allow a duplicate) and passing on the real one. Record the broken variant and its counterexample.
3. A finding stays a finding. If the real model violates a property, that is a bug report or a modelling error to resolve with the user; never weaken or delete the property to get green.
4. Honest scope. State the bounds (processes, queue length, values) and what the model leaves out. Say "no violation found within these bounds", never "verified" without the bounds.
5. Install nothing without asking. Missing tool: one AskUserQuestion naming the tool, why, and the exact install command; install only on yes. Never `curl | sh`; prefer the package manager or a pinned download the user approves. Never read `.env` files. Never push.
6. Only create files under `docs/formal/<name>/`. Change no application code from here; a bug the model finds is reported, fixed in its own change.

## 1. Pick the target

Read `AGENTS.md`, `CONTEXT.md`, `docs/adr/` and the component's code, tests and history (`git log --oneline -- <path>`). Prefer the promise whose breakage harms users and that tests rarely reach (lost update, duplicate send, deadlock, stale read after reconnect), not the easiest module. Choose the tool by the question:

| Question | Tool |
|---|---|
| Ordering, interleaving, concurrency, multi-device state | TLA+ with TLC (default) |
| Per-input behaviour of one function | A code-level verifier for the language, or generated-input (property) tests on the real code |
| No verifier for the language | Property tests on the real code; say so |
| Unbounded claim | Proof assistant (Lean, Coq): propose, do not start without a yes |

If TLA+ is not the right tool, say so and stop here with the alternative; do not force a model.

State the target as a short list of promises, each a sentence a user would recognise ("a message is delivered at most once"; "two devices never both hold the lock"). Ask the user to confirm the list (one AskUserQuestion). Each promise becomes an `INVARIANT` or temporal property.

## 2. Toolchain

Check what exists without installing: `java -version`, then `tlc -h` or a `tla2tools.jar` the repo or user names. TLC needs Java 11 or newer. Missing: ask (rule 5) with the exact command (for example `winget install EclipseAdoptium.Temurin.21.JDK`, `brew install openjdk`, the distribution package) and the TLA+ tools jar from the official release, with the version you will pin. Record the tool versions in the model README (step 3). A repo that already pins a runner (`mise.toml`, `package.json` script) uses that.

## 3. Write the model

Layout (one directory per model, name is lowercase letters, digits, dashes):

```
docs/formal/<name>/
  <Name>.tla     the spec: variables, Init, one action per atomic code step, Next, Spec, the invariants
  <Name>.cfg     TLC config: SPECIFICATION, INVARIANT or PROPERTY lines, CONSTANTS with small bounds
  README.md      promises in plain words, how steps map to code, bounds, what is left out, how to run
  model.json     manifest (step 5)
```

Rules for the spec: one action per atomic step of the code (a read-modify-write that is not atomic in the code is two actions); every action comment names the function and file it models; failures the environment can cause (crash, retry, reorder, duplicate delivery) are explicit actions; constants stay tiny (2 or 3 of each) so TLC finishes in seconds to a few minutes.

## 4. Run, break, replay

1. Run the check: `java -cp <tla2tools.jar> tlc2.TLC -config <Name>.cfg <Name>.tla` (or the repo's wrapper). Record the command, states explored, and the result.
2. For each property, make a broken variant in a scratch copy (not committed as the model; keep the one-line diff in `README.md`), run it, and see the property fail with a counterexample. A property that cannot fail is too weak: tighten it or drop it with the user's say.
3. If the real model fails a property, replay the counterexample against the real code (a test, a script, a trace by hand with file and line). Either the model has an error (fix the model from the code) or the code has a bug (report it with the minimal trace; do not fix it here).
4. Render the state graph as a statechart in the reader's words for review when the user wants a picture: states named by what a user sees, arrows by what happens. Use the `statechart` tool if installed; otherwise a Mermaid `stateDiagram-v2` written by hand from the TLC state graph, kept under about 20 arrows. Save it in `README.md`.

## 5. Record the model

```
{
  "name": "<name>",
  "kind": "tla",
  "spec": "docs/formal/<name>/<Name>.tla",
  "config": "docs/formal/<name>/<Name>.cfg",
  "check": "<exact command from the repo root>",
  "sources": ["src/queue/**", "src/index.ts"],
  "sync": "<full commit hash>"
}
```

`sources` are the globs of the code the model claims to describe (`*`, `**`, `?` only; each must match a tracked file). `name` equals the directory. Write it without `sync` first, commit the model, then set it with the script so the hash is the commit the model was proven against:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/formal-drift.ts" stamp <name>
node "${CLAUDE_PLUGIN_ROOT}/scripts/formal-drift.ts" check
```

(`stamp` needs a valid `sync` field to start from: put the current `git rev-parse HEAD` in first, then stamp after the commit.) `check` must report `in-sync`.

Add the model to the repo's Rule <-> enforcer table through `/h7:retro` style approval: propose the row (rule: the promise; enforcer: the model's check command and `docs/formal/<name>/`), the user approves, then write it. Commit the model, its README and the table row separately, Conventional Commits (`docs(formal): model <name>`), the attribution trailer the session instructs, `git add <explicit paths>`, each commit passing the repo's full local check.

## 6. Report

Brief: the promises, the tool and version, the bounds, per property whether the real model held and whether the broken variant failed (with the counterexample length), any bug or modelling error found, the `check` command, the sync commit, and what is left out. Never say "verified" without the bounds, and never say done while a property has not been shown able to fail.
