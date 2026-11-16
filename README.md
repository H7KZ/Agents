# Agents

`h7` is a universal, cross-repo agent workflow for Claude Code, shipped as a plugin from the `h7kz` marketplace
(this repo). It invests in the agent's environment (guards, checks, verification) instead of reading every diff.

Design and decisions: [docs/design.md](docs/design.md), [docs/adr/](docs/adr/README.md).

## Install

Requires Node 22.18+, git and the Claude Code CLI. The bootstrap adds the `h7kz` marketplace with auto-update,
installs `h7` and `mattpocock-skills` (from `claude-plugins-official`), creates `~/.h7`, and offers to remove
stale duplicate mattpocock copies (it lists them and asks first; `--yes` skips the question).

```powershell
# Windows (PowerShell)
git clone https://github.com/H7KZ/Agents.git; powershell -ExecutionPolicy Bypass -File Agents\bootstrap\install.ps1
```

```sh
# macOS / Linux
git clone https://github.com/H7KZ/Agents.git && sh Agents/bootstrap/install.sh
```

Options: `--dry-run` (print only), `--dev <repo>` (authoring machine, live edits, see below), `--local <path>` (add the
marketplace from a local clone; a copy, not live), `--yes`. It is idempotent and copies the original
`~/.claude/settings.json` to `settings.json.h7bak` (once, before any `claude` command touches it). It adds
`claude-plugins-official` first when that marketplace is unknown, since `mattpocock-skills` comes from there.

### Authoring machine: live edits

A directory marketplace (`--local`) does NOT give live edits: Claude Code copies the plugin into its cache
(`plugins/cache/h7kz/h7/<sha>`). Use `--dev <repo>` instead. It links `<repo>/plugins/h7` into `~/.claude/skills/h7`
(a directory junction on Windows, no admin needed), which Claude Code loads in place as `h7@skills-dir`. No marketplace is
added for h7 and `h7@h7kz` is uninstalled, otherwise h7 and its hook would load twice. Run `/reload-plugins` after edits.
Evidence: [ADR 0003](docs/adr/0003-sync-marketplace-plugin.md). `/h7:doctor` reports which mode is active and fails if both are.

Without the bootstrap: `claude plugin marketplace add H7KZ/Agents` then `claude plugin install h7@h7kz`.

## Commands

| Command | What it does |
|---|---|
| `/h7:doctor` | Read-only check of this machine: Node, git, gh (+auth), claude, marketplace and auto-update, mattpocock skills and duplicates, `~/.h7` |
| `/h7:setup` | Once per repo: interview the repo, write `docs/agents/verification.md`, the AGENTS.md block, and proven `verify-*` skills |
| `/h7:verify` | Run the testing bar scoped to the change (diff coverage, mutation, edge cases, e2e); records `.h7/verify.json` |
| `/h7:review` | Fresh-context lens reviewers (spec, standards, adversarial, security, performance, test quality, architecture); only reproduced findings survive |
| `/h7:ship` | Commit story, PR body, CI watcher (READY / WAITING / BLOCKED); never merges unless the repo opts in |
| `/h7:work` | Driver: research, grill, implement, verify, review, loop, ship, with a run journal in `.h7/runs` |
| `/h7:retro` | Turn corrections into proposed checks; you approve row by row |
| `/h7:improve` | Work the improvement queue in `~/.h7/proposals` |
| `/h7:formal-create`, `/h7:formal-maintain` | Opt-in TLA+/statechart models and drift checks |

All skills are user-invoked only (`disable-model-invocation: true`); nothing auto-triggers. Run `/h7:setup` in a repo
before `/h7:work`. Runner minutes: CI runs 3 cells; run `npm run mutation` locally before merging.

## Always-on safety guard

A `PreToolUse` hook for Bash and PowerShell. It blocks force pushes to protected branches, hook skipping
(`--no-verify`, `HUSKY=0`), destructive git on a dirty tree, committing secrets and recursive deletes outside the
repo; it asks before protected pushes and deploy/publish commands. Near-misses are logged (secrets redacted) to
`~/.h7/guard.log`. Internal errors ask instead of allowing. `H7_GUARD=off` disables it.

It is a safety floor against agent accidents, not a sandbox: anything it cannot resolve statically asks
(git failing or missing, piping into a shell, `xargs`, `iex`, variable command words or delete targets, git aliases,
`find -delete` and `xargs rm` starts), and only clearly destructive, resolvable cases are blocked. State carries across a
chain (`git checkout main && git push -f`, `git stash -u && git reset --hard`, `cd` outside a subshell). Secret files are
tiered: `.env`, `id_rsa`, `*.key`, `*.p12` and similar block; `.env.development`, `*.pem`, `.npmrc`, `*.tfvars` ask
(a `*.pem` holding a private key blocks). Deletes under the OS temp directory are allowed.

## Development

See [AGENTS.md](AGENTS.md). `npm ci && npm run check`.

License: MIT. Attribution: [NOTICE](NOTICE).
