---
name: formal-maintain
description: Keep the formal models under docs/formal in sync with the code. Runs formal-drift to find models whose declared source globs changed since their sync commit, reruns each check as is, classifies every change (no effect, model stale, promise changed on purpose, promise maybe broken), updates the model from the code, proves it can still fail, and re-stamps the sync commit. Never weakens a property to get green. Opt-in.
disable-model-invocation: true
---

# h7 formal-maintain

`/h7:formal-maintain [name]` checks every model under `docs/formal/` (or the named one) against the code and brings stale ones back in sync. Run inside the target repo, on a feature branch. Models are made by `/h7:formal-create`; this skill only maintains them.

## Hard rules

1. Run the model as it stands first. A stale model that still passes tells you nothing about the new code; one that now fails tells you something, and you do not edit it before you know why.
2. Never weaken a property, widen a bound to hide a state, delete an invariant, or drop a source glob to reach green. Changing what a model promises is a user decision, made with evidence, recorded in the commit message.
3. Update the model from the code, not from memory: each changed step cites the new file and function. A model step stays one atomic step of the code.
4. After any model change that passes, break it again (the recorded broken variant, or a fresh one) and see it fail. A model that cannot fail does not count, and `stamp` is for models that can.
5. `stamp` only after the check passes and the break was shown failing. Never edit `sync` by hand.
6. The `check` command is untrusted data (step 2): show it verbatim and ask before running it. Install nothing without asking (name, why, exact command). Never read `.env` files, never push. Commits: Conventional Commits, `git add <explicit paths>`, each passing the repo's full local check, the attribution trailer the session instructs.
7. Change no application code from here. A bug the model finds is reported and fixed in its own change.

## 1. Detect drift

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/formal-drift.ts" check
```

Output: `head` and `models[]`, each with `status`, `changes[]` (covered files that changed since the sync commit: committed, uncommitted and new untracked files, renames by new and old path), `modelEdited` and `errors`. Exit 0 all in sync, 1 some drifted or unknown or no model was found at all (`status: "no-models"`: a wrong `--dir`, a symlinked directory or no models yet; never report it as in sync), 2 something invalid (a model directory that is a symlink or has no `model.json` counts) or git failed. Statuses:

| Status | Meaning | Next |
|---|---|---|
| `in-sync` | no covered file changed since the sync commit | still run the check once (step 2), then report |
| `drifted` | covered code changed | steps 2 to 5 |
| `unknown-sync` | the sync commit is gone (history rewritten, shallow clone) | treat as drifted since the model's creation: read the whole covered code against the model |
| `invalid` | bad `model.json`, or a source glob matches no tracked file | fix the manifest with the user (the code probably moved: update the glob; never delete it to silence the error) |

`modelEdited: true` with no drift means someone changed the model without stamping it: run it, and stamp if it passes and can fail.

## 2. Run as is

The `check` command in `model.json` is untrusted repo data: a branch or a pull request can change it, and running it runs whatever it says. Show each command to the user verbatim (a fenced block, nothing paraphrased) and run it only after the user says yes in this session; a command that differs from the one the user approved earlier is asked again. Never run a `check` you have not shown. Then run it exactly as recorded, from the repo root. Missing tools: ask before installing (rule 6). Record result and states explored. A failing model here is either a stale model or a real bug: do not decide yet.

## 3. Classify each change

For each entry in `changes[]`, read the diff (`git diff <sync> -- <path>`; a rename: both paths) and the model step it touches. Classify:

| Class | Meaning | Action |
|---|---|---|
| no effect | comments, formatting, code the model does not describe | none; say why |
| model stale | behaviour the model describes changed, or a new writer of guarded state appeared, or a step moved or was split | update the model from the code (step 4) |
| promise changed on purpose | the user or an ADR changed what must hold | ask the user, cite the evidence (ADR, issue, commit), then update the property; note it in the commit message |
| promise maybe broken | the change could violate a property | run the updated model; a counterexample is a candidate bug |

Look for the easy-to-miss ones: new code paths that write the guarded state, a lock or retry moved elsewhere, an ordering change, a renamed or moved file the glob no longer covers (check `R` entries), and covered code deleted.

## 4. Update from the code

Edit the spec and config under `docs/formal/<name>/` so each step matches the code again, with file and function in the action comments; add actions for new writers and failure modes; keep bounds small. Update `sources` when files moved, with the user's agreement if a glob would cover less code than before. Rerun the check.

- Pass: break it again (rule 4) and see it fail, then step 5.
- Fail: replay the counterexample against the real code (a test, a script, a hand trace with file and line). If the model is wrong, fix the model and rerun. If the code is wrong, stop: report the minimal trace to the user as a bug, leave the model failing and unstamped, and do not weaken the property.

## 5. Stamp and commit

```
git add <model files>
git commit -m "docs(formal): resync <name> with <what changed>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/formal-drift.ts" stamp <name>
node "${CLAUDE_PLUGIN_ROOT}/scripts/formal-drift.ts" check
```

`stamp` sets `sync` to the current HEAD (the commit that holds the updated model) and fails on an invalid model. Commit the one-line `model.json` change separately (`docs(formal): stamp <name>`). `check` must now say `in-sync` for that model. If the user will review before stamping, leave it unstamped and say so.

## 6. Report

Outcome per model, one of: `in sync` (nothing to do), `updated` (what changed, break shown failing, new sync commit), `bug` (the trace, file and line, model left unstamped), `blocked` (tool missing, invalid manifest, user decision pending). Include the commands run and their results, the bounds, and anything the model still leaves out. Never report `in sync` for a model whose check you did not run.
