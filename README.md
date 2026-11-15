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
git clone https://github.com/H7KZ/Agents.git; ./Agents/bootstrap/install.ps1
```

```sh
# macOS / Linux
git clone https://github.com/H7KZ/Agents.git && ./Agents/bootstrap/install.sh
```

Options: `--dry-run` (print only), `--local <path>` (add the marketplace from a local clone, for authoring), `--yes`.
It is idempotent and backs up `~/.claude/settings.json` to `settings.json.h7bak` before changing it.

Without the bootstrap: `claude plugin marketplace add H7KZ/Agents` then `claude plugin install h7@h7kz`.

## Commands

| Command | What it does |
|---|---|
| `/h7:doctor` | Read-only check of this machine: Node, git, gh (+auth), claude, marketplace and auto-update, mattpocock skills and duplicates, `~/.h7` |

## Always-on safety guard

A `PreToolUse` hook for Bash and PowerShell. It blocks force pushes to protected branches, hook skipping
(`--no-verify`, `HUSKY=0`), destructive git on a dirty tree, committing secrets and recursive deletes outside the
repo; it asks before protected pushes and deploy/publish commands. Near-misses are logged (secrets redacted) to
`~/.h7/guard.log`. Internal errors ask instead of allowing. `H7_GUARD=off` disables it.

## Development

See [AGENTS.md](AGENTS.md). `npm ci && npm run check`.

License: MIT. Attribution: [NOTICE](NOTICE).
