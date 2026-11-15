# 0003. Sync: marketplace plugin with bootstrap
Status: accepted (2026-11-15)
## Context
The workflow must reach several machines and stay current. Authoring must see live edits, other machines must update automatically.
## Decision
Repo is a plugin marketplace (`h7kz`) with one plugin `h7`. No `version` in manifest (commit SHA = version). Authoring machine adds marketplace from the local dir (live). Other machines add `H7KZ/Agents` with `autoUpdate: true`. Bootstrap (`install.ps1` / `install.sh`) wires it, installs mattpocock from `claude-plugins-official`, removes stale duplicates.
## Alternatives considered
- Plain clone + symlink (no versioning, manual updates).
- Full dotfiles installer (heavier than needed).
## Consequences
- Commit SHA is the version; no manual version bumps.
- Bootstrap scripts must handle both Windows and POSIX.
