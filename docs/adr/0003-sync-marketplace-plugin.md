# 0003. Sync: marketplace plugin with bootstrap
Status: accepted (2026-11-15)
## Context
The workflow must reach several machines and stay current. Authoring must see live edits, other machines must update automatically.
## Decision
Repo is a plugin marketplace (`h7kz`) with one plugin `h7`. No `version` in manifest (commit SHA = version). Authoring machine adds marketplace from the local dir (live; see Amendment 2026-11-16: this is wrong). Other machines add `H7KZ/Agents` with `autoUpdate: true`. Bootstrap (`install.ps1` / `install.sh`) wires it, installs mattpocock from `claude-plugins-official`, removes stale duplicates.
## Alternatives considered
- Plain clone + symlink (no versioning, manual updates).
- Full dotfiles installer (heavier than needed).
## Consequences
- Commit SHA is the version; no manual version bumps.
- Bootstrap scripts must handle both Windows and POSIX.

## Amendment 2026-11-16: live edits need a skills-dir link, not a directory marketplace
Status: accepted. Supersedes the "authoring machine adds marketplace from the local dir (live)" claim above.

Evidence (Claude Code 2.1.295, throwaway `CLAUDE_CONFIG_DIR` and HOME, never the real config):
- (a) Directory marketplace: `claude plugin marketplace add <repo>` then `claude plugin install h7@h7kz`. `claude plugin list --json`
  gives `installPath` = `<config>/plugins/cache/h7kz/h7/<sha>` (a copy) and `readFromFolder` = `<repo>/plugins/h7`. Uncommitted edits
  are not live; even committed ones need an update, because the cache is keyed by commit SHA.
- (b) `~/.claude/skills/h7` junction to `<repo>/plugins/h7` (a plugin dir with `.claude-plugin/plugin.json`):
  `claude plugin list --json` gives `id: h7@skills-dir`, `installPath` = the link itself, nothing in `plugins/cache`. After editing
  `skills/doctor/SKILL.md` in the target, `claude plugin details h7` changed the doctor skill's always-on token cost from ~50 to under 20
  with no reinstall, so the loaded files are the working tree.
- (c) `claude --plugin-dir <dir>` also loads in place (`id: h7@inline`, `scope: session`) but is per session, so it is not a standing setup.
- `claude plugin marketplace add` also rewrites settings.json and records `extraKnownMarketplaces.h7kz` without `autoUpdate`.

Decision: bootstrap `--dev <repo>` creates the `~/.claude/skills/h7` link (`fs.symlinkSync(target, path, 'junction')`, no admin on
Windows), adds no marketplace for h7 and uninstalls `h7@h7kz`, because loading both runs every hook twice. The h7kz marketplace holds only
h7, so nothing else is lost. Other machines keep the GitHub marketplace with `autoUpdate`. `--local` stays for testing the install path
and is documented as a copy. Doctor reports dev vs marketplace mode and fails when both are present.
