---
name: doctor
description: Check this machine's h7 setup (Node, git, gh, claude CLI, h7kz marketplace and auto-update, mattpocock skills and duplicates, ~/.h7) and report failures with suggested fixes. Read-only.
disable-model-invocation: true
---

# h7 doctor

Run the environment checks and report. Change nothing.

1. Run exactly this command and capture its JSON output:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.ts"
```

2. Parse the JSON. Fields: `ok`, `pass`, `warn`, `fail`, and `checks[]` with `id`, `status` (`pass`, `warn`, `fail`), `detail`, optional `fix`.
3. Reply with one line per check: status, id, detail. List failures and warnings first.
4. For each failing or warning check, show its `fix` text verbatim as a suggestion for the user to run. Do not run any fix yourself, and do not edit settings, plugins or files.
5. End with the totals (`pass`, `warn`, `fail`). If `ok` is true, say the machine is ready.

If the command itself fails (for example Node is older than 22.18 so `.ts` cannot run), report that as the single failure and suggest installing Node 22.18 or newer.
