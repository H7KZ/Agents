# Claude Code extension mechanics: research for H7KZ/Agents

Date: 2026-11-15. Local Claude Code: `2.1.295` (`claude --version`). Docs host is now `code.claude.com/docs/en/...` (old `docs.claude.com/en/docs/claude-code/...` paths redirect there).

Purpose: inputs for a grilling session on how to build a modular, universal, cross-machine set of skills/scripts/hooks/commands/subagents. Facts only, each with its source. Opinions are confined to the last two sections and marked as such.

Abbreviations for sources:
- **[skills]** https://code.claude.com/docs/en/skills
- **[plugref]** https://code.claude.com/docs/en/plugins-reference (plugin manifest reference)
- **[mkt]** https://code.claude.com/docs/en/plugin-marketplaces (create a marketplace)
- **[host]** https://code.claude.com/docs/en/plugins/host-marketplace.md
- **[load]** https://code.claude.com/docs/en/plugins/loading.md
- **[hooks]** https://code.claude.com/docs/en/hooks
- **[agents]** https://code.claude.com/docs/en/sub-agents
- **[cmds]** https://code.claude.com/docs/en/commands
- **[goal]** https://code.claude.com/docs/en/goal.md
- **[loop]** https://code.claude.com/docs/en/scheduled-tasks.md
- **[mem]** https://code.claude.com/docs/en/memory
- **[headless]** https://code.claude.com/docs/en/headless
- **[gha]** https://code.claude.com/docs/en/github-actions
- **[spec]** https://agentskills.io/specification
- **[agentsmd]** https://agents.md/
- **[codex-skills]** https://learn.chatgpt.com/docs/build-skills (redirect target of developers.openai.com/codex/skills)
- **[codex-hooks]** https://learn.chatgpt.com/docs/hooks.md (redirect target of developers.openai.com/codex/hooks)
- **[cursor]** https://cursor.com/docs/skills
- **[gemini]** https://geminicli.com/docs/cli/skills/
- **[mp]** mattpocock/skills, read at two points in time: local copy v1.2.3 at `<home>/.claude\plugins\marketplaces\local-desktop-app-uploads\mattpocock-skills\` and upstream `main` @ `5863806` (2026-11-12, plugin.json v1.3.2) via `gh api repos/mattpocock/skills/...`

---

## 1. Skills

### Format
- A skill is a directory with `SKILL.md`: YAML frontmatter between `---` lines (the opening `---` must be line 1), then Markdown. Claude Code follows the Agent Skills open standard and adds extensions (invocation control, subagent execution, dynamic context injection). [skills]
- Supporting files sit beside it (`reference.md`, `scripts/helper.py`). Scripts are executed, not loaded. Keep `SKILL.md` under 500 lines. [skills], [spec]

### Frontmatter (Claude Code). All optional. Unknown fields are silently ignored. [skills]
| Field | Effect |
|---|---|
| `name` | `/` command name. Defaults to the directory name. |
| `description` | When to use it. Falls back to the first content line. Combined with `when_to_use`, truncated at **1,536 chars** in the listing (configurable `skillListingMaxDescChars`). |
| `when_to_use` | Extra trigger text appended to description. |
| `argument-hint`, `arguments` | Autocomplete hint. Named positional args for `$name`. |
| `disable-model-invocation` | `true`: only the user can invoke. Description is **not** in context. Also blocks preloading into subagents and firing from scheduled tasks (so `/loop` can't run it). |
| `user-invocable` | `false`: hidden from `/` menu, model-only. |
| `allowed-tools` | Tools pre-approved for the **invoking turn only**. The grant clears on the next user message. It does not restrict other tools. |
| `disallowed-tools` | Removed while active. |
| `model`, `effort` | Override for the current turn. |
| `context: fork` + `agent` + `background` | Run the skill in a forked subagent (`Explore`/`Plan`/`general-purpose`/custom). It doesn't see conversation history. Runs in the background by default. |
| `hooks` | Hooks registered on invocation that **stay for the rest of the session**. `once: true` removes one after its first successful run. |
| `paths` | Globs that limit auto-activation to matching files. |
| `shell` | `bash` (default) or `powershell` for `` !`cmd` `` blocks. |
| `metadata`, `license`, `compatibility` | Spec fields. Claude Code accepts them and does nothing with them. |

- Outside Claude Code (claude.ai uploads, Skills API) only `name, description, license, compatibility, metadata, allowed-tools` are allowed. Any other key is a hard error. [skills]

### Substitution and injection. [skills]
- `$ARGUMENTS`, `$ARGUMENTS[N]`/`$N`, `$name`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, and for plugins `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`. If nothing consumes the args, `ARGUMENTS: <value>` is appended.
- `` !`cmd` `` (or a ```` ```! ```` block) runs **before** Claude sees the skill and inlines the output. **A non-zero exit aborts the whole invocation.** Add `|| true` when a non-zero exit is expected. The command is checked against permission rules and is not prompted, so pre-approve it with `allowed-tools`. The default timeout is 2 min. This is how a universal skill can pull repo-specific config at invocation time (see §8).

### Load locations and precedence. [skills]
- Enterprise (managed) > Personal `~/.claude/skills/<n>/SKILL.md` > Project `.claude/skills/<n>/`. Plugin skills are namespaced `/<plugin>:<skill>` and never collide.
- Project skills load from the start dir **and every parent up to the repo root**. Nested `.claude/skills` load lazily the first time a file in that subdir is touched. Same-named nested skills are addressed as `/apps/web:deploy`.
- A skill folder may be a **symlink**. The target loads once.
- **A user skill replaces a bundled command of the same name** (aliases excepted). A skill replaces a `.claude/commands/` file of the same name.
- Live reload: edits under `~/.claude/skills`, `.claude/skills` and `--add-dir` dirs apply without a restart. A brand-new top-level skills dir needs `/reload-skills`.

### Invocation. [skills]
- Default: user (`/name`) and model can both invoke. `disable-model-invocation: true` = user-only, with zero context cost. `user-invocable: false` = model-only.
- `/name` at the start of a message runs it. `/name` mid-text only grants permission. Up to six skills can be stacked: `/a /b text`. [cmds]
- `skillOverrides` setting: `on | name-only | user-invocable-only | off`. Permission rules `Skill(name)` can deny.
- Listing budget = **1% of the context window**. When it overflows, the descriptions of the least-invoked skills are dropped first. Tunable via `skillListingBudgetFraction` / `SLASH_COMMAND_TOOL_CHAR_BUDGET`. `/skill-doctor` reports per-skill cost and use.
- Body lifecycle: once invoked, the content stays in context across turns and is **not re-read**. After compaction, only the first 5,000 tokens per skill are re-attached (25k total). So put the critical rules at the top, and put must-hold rules in hooks.
- Evaluation: the `skill-creator` plugin and `claude plugin eval` (evals/evals.json, with-vs-without-skill benchmark, description trigger tuning).

### Commands = skills
- `.claude/commands/*.md` still works with the same fields (except `name`, `paths`). Subdirectories give colon names. Prefer `skills/` for new work. [skills], [plugref]

### Bundled skills relevant to the workflow. [cmds], [skills]
- `/loop`, `/verify`, `/run`, `/run-skill-generator`, `/code-review` (alias `/review`; `--fix`, `--comment`, `ultra` cloud), `/simplify` (4 parallel cleanup agents, no bug hunting), `/batch` (5–30 units in parallel worktrees, each opening a PR), `/security-review`, `/debug`, `/doctor`, `/fewer-permission-prompts`, `/update-config`. Disable them with `disableBundledSkills`.

---

## 2. Plugins and marketplaces (the sync mechanism)

### Plugin layout and manifest. [plugref]
- `.claude-plugin/plugin.json` is **optional**. Only `name` (kebab-case) is required. Every component is namespaced `name:component`.
- Default dirs at the plugin root: `skills/<n>/SKILL.md`, `commands/`, `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `output-styles/`, `workflows/`, `themes/`, `monitors/monitors.json`, `bin/` (on the Bash PATH while the plugin is enabled; claude.ai and Cowork refuse plugins with a top-level `bin/`).
- Manifest keys: `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `displayName`, `defaultEnabled` (default true), `dependencies`, `userConfig` (prompted values; `sensitive` values go to the OS keychain; exposed as `${user_config.KEY}` and `CLAUDE_PLUGIN_OPTION_<KEY>` env to hooks), `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`, `workflows`, `experimental.{themes,monitors,evals}`.
- How the keys combine with the default dirs: `skills` **adds to** `skills/`. `commands`, `agents`, `outputStyles` **replace** their default dirs. `hooks`, `mcpServers`, `lspServers` **merge**.
- Paths must start with `./` and must stay inside the plugin root. `..` is rejected. Backslash paths fail on macOS/Linux, so always use `/`.
- `CLAUDE.md` at the plugin root is **not** loaded. Put context in a skill.
- Env vars: `${CLAUDE_PLUGIN_ROOT}` (the version dir; it changes on update), `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`, persists across updates), `${CLAUDE_PROJECT_DIR}`. None of these are present in Bash-tool commands. Write the `${...}` form in the Markdown body instead, where it is substituted at load time.
- On Windows, substituted paths use forward slashes, except in exec-form hooks and PowerShell hooks.
- Validate with `claude plugin validate <dir> [--strict]`. It also validates a skills dir (`claude plugin validate ~/.claude/skills`). [skills]
- Names starting `claude-`, `anthropic-`, `cc-plugin-` are reserved (error).

### Marketplace = a git repo with `.claude-plugin/marketplace.json`. [mkt], [host]
```json
{ "name": "h7kz", "owner": {"name": "H7KZ"},
  "plugins": [ {"name": "core", "source": "./plugins/core", "description": "..."} ] }
```
- Entry `source` types: relative path, `github` (`repo`, `ref`, `sha`), `url` (any git), `git-subdir` (monorepo path), `archive` (zip+`sha256`), `npm`, `command`. [mkt]
- Users run `claude plugin marketplace add H7KZ/Agents` (or `/plugin marketplace add`), then `claude plugin install core@h7kz`. `#ref` pins a branch or tag. The marketplace name comes from the JSON, not the repo. [host]
- **A repo can be both marketplace and plugin.** mattpocock uses `"source": "./"` with plugin.json at the same root. [mp] `.claude-plugin/marketplace.json`
- Keep the entry `name` equal to the manifest `name`. The entry name is the install key; the manifest name is the namespace. [mkt]
- `renames` map plus `forceRemoveDeletedPlugins` let you rename or remove plugins without breaking installs. There is no deprecation state. [host]
- Private repo: Claude Code runs non-interactive `git` with the machine's existing credentials (ssh-agent, or a credential helper that has a stored credential). `GITHUB_TOKEN` alone doesn't help. Run `gh auth login && gh auth setup-git`. Without an SSH key, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`. [host]
- Plugins can depend on other plugins, including ones from another marketplace, if the marketplace lists it in `allowCrossMarketplaceDependenciesOn`. Semver ranges resolve against `<plugin>--v<version>` tags. [host], [plugref]

### Versions, caching, auto-update. [load], [host]
- Computed version: `plugin.json` `version`, then the entry's `version`, then for git sources the **12-char commit SHA**. **If you pin `version` and forget to bump it, users never update.** Omit `version` to track commits.
- Installed plugins are **copied** to `~/.claude/plugins/cache/<mkt>/<plugin>/<version>/`. Files outside the plugin dir aren't copied (`../shared` breaks). Old versions are removed 14 days after being orphaned.
- Symlinks inside the plugin are preserved. Symlinks elsewhere in the same marketplace are **dereferenced** (copied), so a meta-plugin can link to sibling plugins' skills. Symlinks outside the marketplace are skipped. On Windows, `mklink /D` needs elevation or Developer Mode. [host]
- **Loaded in place (no copy, no version bump):** `--plugin-dir`, plugins under `~/.claude/skills/` or `.claude/skills/` that contain `.claude-plugin/plugin.json` (id `@skills-dir`), and relative-path plugins in a marketplace **added from a local directory**. Edits apply at the next session or `/reload-plugins`. [load]
- **Auto-update default: on for Anthropic official marketplaces, off for every third-party marketplace.** Turn it on with `/plugin` → Marketplaces → Enable auto-update (written to `known_marketplaces.json`), or with `"autoUpdate": true` on the `extraKnownMarketplaces` entry in a settings file. The update runs at a random delay ≤10 min after the first message and asks you to `/reload-plugins`. It's disabled by `DISABLE_AUTOUPDATER`/`DISABLE_UPDATES`/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` unless `FORCE_AUTOUPDATE_PLUGINS=1`. Manual: `claude plugin update <p>@<m>` or `/plugin marketplace update <m>`. [load]
- Release channels mean two marketplaces with different `name`s pointing at different refs. [host]
- Repo-shared enablement: `.claude/settings.json` with `extraKnownMarketplaces` and `enabledPlugins` registers the marketplace for teammates who trust the folder. A plugin enabled only at project scope still needs `claude plugin install ... --scope project` on each machine. `enabledPlugins` precedence: managed > flag > local > project > user. [load], [host]
- Components that a repo-scoped plugin is denied (MCP bundles, monitors) are listed in [load]. These limits don't apply to your own `~/.claude/skills`.

### Local install state on this machine (observed 2026-11-15)
- `~/.claude/plugins/known_marketplaces.json`: `claude-plugins-official` (github `anthropics/claude-plugins-official`), `gitkraken` (directory), `local-desktop-app-uploads` (directory).
- `~/.claude/plugins/installed_plugins.json`: `mattpocock-skills@local-desktop-app-uploads` **v1.2.3** (uploaded via the desktop app, a directory marketplace, so it loads **in place** from `~/.claude/plugins/marketplaces/local-desktop-app-uploads/mattpocock-skills/`; there is no cache dir and it never auto-updates). Also context7, github, security-guidance, typescript-lsp, figma (official), gitkraken-hooks.
- `~/.claude/skills/`: 23 **symlinks** → `~/.agents/skills/*` plus the real dir `security-audit`. Installed by **skills.sh** (`npx skills add`) on 2026-07-19. The lock is `~/.agents/.skill-lock.json` (v3): 22 skills from `mattpocock/skills` (older layout: still has `writing-great-skills`, `resolving-merge-conflicts`, `improve-codebase-architecture`) plus `find-skills` from `vercel-labs/skills`.
- **Consequence:** mattpocock skills are installed **twice**. The session skill list shows both `code-review` and `mattpocock-skills:code-review`, `tdd` and `mattpocock-skills:tdd`, and so on. mp README: "Pick one per agent, because installing both gives you every skill twice." The unprefixed personal `code-review` skill also **shadows Claude Code's bundled `/code-review`** (a user skill replaces a bundled command of the same name, per [skills]). Upstream is now v1.3.2 in `claude-plugins-official` (auto-updating by default), so both local copies are stale.
- `~/.claude/settings.json`: `enabledPlugins`, `extraKnownMarketplaces.gitkraken`, `"autoUpdatesChannel": "latest"`, `outputStyle: Concise`, `effortLevel: low`. Git Bash is present at `/usr/bin/bash`. `pwsh` (PS7) is not on PATH; only Windows PowerShell 5.1 is.

### Sync options compared (facts)
| Mechanism | What syncs | Update path | Hooks/agents? | Cross-tool | Windows notes |
|---|---|---|---|---|---|
| **Git marketplace + plugin** (`marketplace add H7KZ/Agents`) | skills, agents, hooks, MCP, output styles, bin | auto-update (once turned on) or `plugin update`. Commit-SHA versioning if `version` is omitted | yes. Plugin agents **ignore `hooks`, `mcpServers`, `permissionMode`** [agents] | Codex and Copilot CLIs reportedly install from the same `.claude-plugin/marketplace.json` (mp README: `codex plugin marketplace add mattpocock/skills`; mp has no `.codex-plugin/`). **Unverified against Codex docs.** Codex sets `CLAUDE_PLUGIN_ROOT` for hook compatibility [codex-hooks] | copied to cache. Symlink rules above |
| **Local-directory marketplace** (on the authoring machine: `marketplace add <home>/Documents/GitHub/Agents`) | same | **in place**: edits are live after `/reload-plugins` | yes | – | no copy, so no symlink issues |
| **Plugin dir under `~/.claude/skills/<name>`** (`@skills-dir`) | whole plugin, in place | `git pull` | yes (no trust prompt for your own `~/.claude/skills`) | the skills subdirs are not auto-seen by other tools | needs a symlink or junction into the repo, or a clone there |
| **Symlink each skill** into `~/.claude/skills` + `~/.agents/skills` (mp `scripts/link-skills.sh`) | skills only | `git pull` | no; hooks need a settings.json merge, agents need a `~/.claude/agents` link | yes: `~/.agents/skills` is read by Codex [codex-skills], Cursor [cursor], Gemini [gemini]. Cursor also reads `~/.claude/skills` | `ln -s` in Git Bash makes copies unless `MSYS=winsymlinks:nativestrict` and Developer Mode are set |
| **skills.sh** (`npx skills add H7KZ/Agents`) | copies skills | `npx skills update` (manual) | no | yes (multi-agent installer) | already in use on this machine |
| **Install script** (bootstrap.ps1 + .sh) | anything | re-run | yes (can merge settings) | yes | you own all the edge cases |

---

## 3. Hooks

### Events. [hooks]
"Can block" means exit code 2 or a `decision:"block"` changes control flow.
- **Blocking:** `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PostToolBatch` (stops the loop), `SubagentStop` (subagent keeps going), `TaskCreated`, `TaskCompleted`, **`Stop` (Claude keeps working)**, `TeammateIdle`, `ConfigChange`, `WorktreeCreate`, `PreCompact`, `PreModelSwitch`, `Elicitation(Result)`.
- **Non-blocking:** `SessionStart`, `Setup`, `PermissionRequest` (deny via its `decision` object), `PermissionDenied`, `PostToolUse` (`decision:block` attaches the reason; `updatedToolOutput` rewrites output), `PostToolUseFailure`, `Notification`, `MessageDisplay`, `SubagentStart`, `StopFailure`, `InstructionsLoaded`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeRemove`, `PostCompact`, `PostModelSwitch`, `SessionEnd`.

### Handlers. [hooks]
- `command`, `http`, `mcp_tool`, `prompt` (single-turn model verdict), `agent` (subagent with Read/Grep/Glob; experimental).
- Command fields: `command`, `args` (**exec form**: no shell, one arg per element), `shell` (`bash`|`powershell`), `timeout` (s; default 600 for command), `async`, `asyncRewake` (background hook; exit 2 wakes Claude), `once` (skills only), `if` (permission-rule filter such as `Bash(git *)`), `onFailure` (`block`|`continue`), `statusMessage`.
- Exit codes: 0 = ok (stdout JSON parsed; plain stdout goes to context for SessionStart/UserPromptSubmit). **2 = block** (stderr is the reason). Any other code = non-blocking error.
- JSON out: `continue:false` + `stopReason` (halts everything), `decision`/`reason`, `systemMessage`, `hookSpecificOutput.{hookEventName, additionalContext (≤10,000 chars), permissionDecision, updatedInput...}`.
- Matchers: exact name or `A|B` list, otherwise unanchored JS regex. MCP tools use `mcp__srv__.*`.
- Config locations: `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed, plugin `hooks/hooks.json` (top-level `"hooks"` wrapper, optional `description`), skill/agent frontmatter. All of these **merge**. `disableAllHooks` disables everything; there is no per-hook disable.
- SessionStart: `additionalContext` or plain stdout goes into context. Append `export` lines to `$CLAUDE_ENV_FILE` to persist env for Bash. Input `source` is one of `startup|resume|clear|compact|fork`. [hooks]

### Stop hook as a verification gate. [hooks]
- Input: `stop_hook_active` (true when Claude is already continuing because of a stop hook), `last_assistant_message`, `background_tasks[]`, `session_crons[]`.
- To force continuation, use `{"decision":"block","reason":"..."}` or exit 2 with stderr. Alternatively `hookSpecificOutput.additionalContext` continues without being labelled an error ("Stop hook feedback").
- **Loop guard: an 8-consecutive-continuation cap.** After 8 blocks in a row, the next block is overridden. The counter **resets whenever Claude calls a tool**, so a gate that makes Claude run tests each round can loop indefinitely. Raise the cap with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. `onFailure` has no effect on Stop.
- Scoping: a `Stop` in **subagent frontmatter becomes `SubagentStop`**. **Skill-frontmatter hooks persist for the rest of the session** after invocation. That gives "verification gating only once `/ship` is invoked" without a global hook firing on every Q&A turn.
- `/goal` **is** a session-scoped prompt-based Stop hook (see §5).

### Cross-platform. [hooks], [plugref]
- Windows default shell: **Git Bash if installed, otherwise PowerShell**. `"shell": "powershell"` forces PowerShell. `CLAUDE_CODE_GIT_BASH_PATH` points at a Bash it can't find.
- Without Git Bash, a PreToolUse/PermissionRequest hook exiting with anything other than 0 or 2 counts as a failure.
- Exec form needs a real executable (`.exe`). For `.cmd`/`.bat` shims (npm bins), use `node script.js` or shell form.
- Portable recipe implied by the docs: exec form `{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/hooks/gate.mjs"]}`. Node is a real exe on all OSes, there is no quoting problem, and backslash paths stay native in exec form. In shell-form hooks, quote `"${CLAUDE_PLUGIN_ROOT}"`. The validator warns when it's unquoted.
- Codex hooks are similar but differ in places: `~/.codex/hooks.json` or `[hooks]` in config.toml, plugin `hooks/hooks.json`, events PreToolUse/PostToolUse/Stop/SubagentStop/SessionStart/UserPromptSubmit/... It accepts `{"decision":"block","reason"}` and exit 2 on Stop. Stop **requires JSON stdout** on exit 0 (plain text is invalid). It has `commandWindows` for a Windows override, requires a `/hooks` trust review, and supplies `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` "for compatibility with existing plugin hooks". [codex-hooks]
- Cursor has hooks (`hooks.json`; its docs list a `/create-hook` skill) with its own schema. Not researched in depth. [cursor]

---

## 4. Subagents (independent reviewers). [agents]
- Files: `.claude/agents/*.md` (project; walks up to the repo root; recursive; identity comes from `name`), `~/.claude/agents/`, plugin `agents/` (subfolders join the name: `plugin:review:security`), `--agents '<json>'`, managed. Precedence: managed > CLI > project > user > plugin.
- Frontmatter: `name` and `description` are required. Optional: `tools` (allowlist; inherits all if omitted), `disallowedTools`, `model` (`sonnet|opus|haiku|fable|inherit|<id>`), `permissionMode`, `maxTurns`, `skills` (preload ≤32 full skills), `mcpServers`, `hooks`, `memory` (`user|project|local` → `~/.claude/agent-memory/<n>/` or `.claude/agent-memory[-local]/<n>/`, MEMORY.md first 200 lines/25KB injected), `background`, `omitClaudeMd`, `effort`, `isolation: worktree`, `color`, `initialPrompt`, `autoCompactWindow`.
- **Plugin subagents ignore `hooks`, `mcpServers`, `permissionMode`.** Copy them to `.claude/agents` if you need those.
- **Fresh context:** no conversation history, no prior skills, no files already read. Input is Claude's delegation message. Startup gets its system prompt, CLAUDE.md (skipped by Explore/Plan and `omitClaudeMd`), a git status snapshot, preloaded skills, and the sibling roster. Only the summary returns. Forks (`/subtask`) inherit the parent conversation.
- Invocation: auto-delegation by `description` ("use proactively" helps), natural language, `@agent-name`, or session-wide `claude --agent x` / `"agent"` setting.
- Nesting: subagents can spawn subagents up to **3 levels** (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). The default concurrency limit is 20. They can be resumed with `SendMessage` by id (not Explore/Plan).
- Model resolution: per-call alias > agent `model` > `CLAUDE_CODE_SUBAGENT_MODEL` > parent.
- Reviewer patterns: read-only `tools: Read, Grep, Glob, Bash` with `model: opus` and `isolation: worktree`, so a reviewer can run tests without touching the main tree. mp `code-review` gets independence from ad-hoc parallel subagents instead of named agent files ([mp] `skills/engineering/code-review/SKILL.md`).

---

## 5. `/loop`, `/goal`, and the CI-watching primitives

- **`/goal [condition|clear]`** is built in (not a skill). [cmds], [goal]
  - It's a session-scoped **prompt-based Stop hook**. After each turn, the small fast model judges the condition against the **transcript only** (it runs no tools), giving one of three verdicts: not met (continue with the reason as guidance), met (cleared), or impossible (cleared as failed).
  - Condition ≤4,000 chars. Write it as something Claude's own output can demonstrate ("`npm test` exits 0", "`gh pr checks` all pass"). Add "or stop after N turns" to bound it.
  - One goal per session. It's restored on resume. It works in `-p`, desktop and Remote Control.
  - Evaluation is skipped while subagents or background shells run. A check-in comes after 30 min of background work (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`).
  - The loop stops if there's no tool use for several turns.
  - It doesn't change the permission mode, so combine it with auto mode for unattended runs.
  - Unavailable when `disableAllHooks` is set or the folder is untrusted.
- **`/loop [interval] [prompt]`** is a **bundled skill**. Alias `/proactive`. [cmds], [loop]
  - A fixed interval (`5m`, `every 2h`) uses cron (1-min granularity, jittered). With no interval it **self-paces** between 1 min and 1 h based on activity, and can stop itself (`ScheduleWakeup stop:true`).
  - With no prompt it runs the built-in maintenance prompt: continue unfinished work, then **tend the current branch's PR (review comments, failed CI runs, merge conflicts)**, then cleanup passes. `.claude/loop.md` (project) or `~/.claude/loop.md` replaces that default (≤25,000 bytes, hot-reloaded each iteration).
  - It can loop a skill (`/loop 20m /review-pr 1234`), but **not** one with `disable-model-invocation: true`.
  - Recurring tasks expire after **7 days**. Max 50 per session. Underlying tools: `CronCreate/CronList/CronDelete`. `CLAUDE_CODE_DISABLE_CRON=1` disables it.
  - Esc stops a self-paced loop; fixed-interval loops have to be cancelled by asking.
  - The docs suggest the **Monitor tool** (a background script that streams lines) instead of polling, and **Channels** (CI pushes failures into the session) for event-driven work.
- Comparison table from [goal]: `/goal` = next turn when the previous ends, stops on condition. `/loop` = next turn on interval. Stop hook = your own script decides, applies to every session in its scope.
- Unattended or cross-session options: cloud scheduled tasks (`/schedule`, min 1h, fresh clone), Desktop scheduled tasks, and GitHub Actions. [loop]
- Headless: `claude -p "/goal ..."` runs to completion. `--output-format stream-json --verbose` streams progress. `-p` waits for background work up to 10 min idle (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`) and waits for pending self-paced `/loop` wakeups. `--bare` skips hooks, skills, plugins, CLAUDE.md and auto memory (CI determinism), so don't use it when you need hooks. `system/init` exposes `plugins`/`plugin_errors` so CI can fail when a plugin didn't load. [headless]
- GitHub Actions: `anthropics/claude-code-action@v1`. Inputs: `prompt` (text or `/skill`, or `/plugin:skill`), `claude_args`, `anthropic_api_key` | `claude_code_oauth_token`, `plugin_marketplaces` (git URLs, newline-separated), `plugins` (`name@marketplace`), `settings`, `trigger_phrase`. A repo `.claude/skills` needs `actions/checkout` first. Commits made with the default `GITHUB_TOKEN` don't trigger CI, so let the action use the Claude App token. Setup: `/install-github-app`. [gha]

---

## 6. mattpocock/skills

### Distribution and conventions. [mp]
- Upstream plugin.json v1.3.2 lists 27 promoted skills. Buckets: `engineering/`, `productivity/` (shipped), `misc/`, `in-progress/`, `deprecated/` (not shipped). (`CLAUDE.md` in the repo.)
- Install routes (README @5863806): Claude `claude plugin install mattpocock-skills@claude-plugins-official` (auto-updates). Codex `codex plugin marketplace add mattpocock/skills` + `codex plugin add mattpocock-skills@mattpocock`. Copilot `copilot plugin ...` + `extraKnownMarketplaces` autoUpdate. Gemini `gemini skills install <git> --path skills/engineering`. Everyone else `npx skills@latest add mattpocock/skills -a <agent>`. "Pick one per agent."
- The official listing **pins a sha**, so releases reach users only when the pin moves. Verified on 2.1.222. (`.agents/adr/0002-ship-as-a-claude-code-plugin.md`)
- Codex's `plugin.json` accepts `skills` only as a **single path** and Codex **drops symlinks** on install. That's why mp deferred a native Codex plugin. (ADR-0002, local v1.2.3; the upstream README now documents a Codex install from the repo marketplace)
- Every skill also has `agents/openai.yaml` (Codex UI metadata). User-invoked skills set `disable-model-invocation: true` **and** `policy.allow_implicit_invocation: false`. (`.agents/invocation.md`)
- **Invocation rule:** user-invoked skills orchestrate; model-invoked skills hold reusable discipline. A user-invoked skill may call model-invoked ones, never another user-invoked one. Dependencies are written as prose (`Call the Skill tool with "tdd"`), never as cross-folder file links. (`.agents/invocation.md`, README "Reference")
- **Per-repo config**, written by `/setup-matt-pocock-skills`: `docs/agents/issue-tracker.md` (GitHub via `gh` / GitLab via `glab` / local `.scratch/<feature>/` / other), `docs/agents/triage-labels.md`, `docs/agents/domain.md`, plus an `## Agent skills` block in whichever of `CLAUDE.md`/`AGENTS.md` already exists. It never creates the other one. (`skills/engineering/setup-matt-pocock-skills/SKILL.md`)
- Hard vs soft dependency on that config: `to-spec`, `to-tickets`, `triage` fail without it; others degrade gracefully. (`.agents/adr/0001-...md`)
- **Domain docs:** `CONTEXT.md` (glossary only, no implementation detail), or `CONTEXT-MAP.md` + per-context `CONTEXT.md` in monorepos. `docs/adr/NNNN-*.md`. All created lazily. An ADR is written only when the decision is hard to reverse, surprising without context, **and** a real trade-off. (`skills/engineering/domain-modeling/SKILL.md`, `setup-matt-pocock-skills/domain.md`)
- Other artifacts: specs/tickets go to the tracker (local: `.scratch/<feature>/issues/NN-slug.md`). Handoffs go to the **OS temp dir**. The architecture report goes to temp HTML. Prototypes go to a `prototype/<name>` branch. Research goes "where the repo already keeps such notes". `.out-of-scope/*.md` is the record of rejected requests.

### Skills (upstream @5863806). U = user-invoked, M = model-invoked.
| Skill | Inv | Purpose / chaining |
|---|---|---|
| ask-matt | U | Router over the flows. Main flow: `grill-with-docs → (prototype via handoff) → to-spec → to-tickets → implement (tdd inside, code-review at end)`. Phase-boundary tree: Continue > /clear > /handoff > subagent > /compact. Keep grill→to-tickets in one context (~150k "smart zone"). |
| grill-with-docs | U | `/grilling` + `/domain-modeling`. Updates CONTEXT.md/ADRs inline. |
| grill-me | U | Stateless `/grilling`. |
| grilling | M | Design-tree interview in **rounds**. Asks the whole frontier at once with a recommended answer per question. Facts are found by subagents, never asked of the user. Done when the frontier is empty and the user confirms. |
| domain-modeling | M | Challenge terms, build scenarios, cross-check code, write CONTEXT.md/ADRs. |
| codebase-design | M | Deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality). Deletion test. "Two adapters = real seam". |
| to-spec | U | Synthesise the conversation into a spec. No interview. Sketch the test seams (as few as possible, ideally 1). Publish to the tracker with `ready-for-agent`. |
| to-tickets | U | Tracer-bullet vertical slices with **blocking edges**. Wide refactors use expand–contract. The user approves the breakdown. Publish to the tracker. |
| implement | U | "Call /tdd at pre-agreed seams; typecheck + single test files regularly, full suite once at end; /code-review; **commit to current branch**." Five lines. |
| implement-spec | U | **New.** Integration branch; ticket **task graph/frontier**; one fresh implementer subagent per ticket in its own **worktree** running `tdd`; merger subagent; at the end `code-review` + **one** fix subagent; draft PR → ready; clean up worktrees. |
| tdd | M | Red→green vertical slices. Tests only at **pre-agreed seams** confirmed by the user ("You can't test everything"). Anti-patterns: implementation-coupled, tautological, horizontal slicing. Refactoring belongs to review. |
| code-review | M | Two axes in **parallel fresh-context subagents**: Standards (repo docs + 12 Fowler smells, repo overrides) and Spec (missing / scope creep / wrong). Not merged or reranked. <400 words each. |
| diagnosing-bugs | M | Phase 1 builds a **tight, red-capable** feedback loop (10 techniques incl. property/fuzz, bisect, differential, HITL script). Then reproduce → minimise → hypothesise → instrument → fix → regression test. Redact secrets. |
| prototype | M | Throwaway code answering one question (LOGIC single HTML, or UI variants). Captured on a branch. |
| research | M | Background agent. Primary sources. Cited markdown in the repo. |
| triage | U | Issue/PR state machine (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Verifies or reproduces claims. Posts agent briefs. AI disclaimer on comments. |
| improve-codebase-architecture | U | Hot-spot scan (git log) → HTML report in temp with deepening candidates → grill the chosen one. |
| wayfinder | U | Multi-session fog: a `wayfinder:map` issue plus decision tickets (research/prototype/grilling/task). Decisions, not deliverables. Hands off to to-spec. |
| pr | M | **New.** PR body template: Summary (diagram/tree/diff), Evidence (before/after), Merge Danger (one/two-way door, blast radius). **Writes the body only.** |
| retro | U | **New.** Session retrospective that proposes **environment** fixes: navigation pointers, automated checks (wire the existing lint/test into pre-commit/CI; a repo with no guardrail is itself a finding), mechanical rules become linters with only judgement calls going to `CODING_STANDARDS.md`, trimming AGENTS.md, tool economy, no-ops, information access. "Reviewer imposes standards, not implementer." |
| wizard | M | Generates an interactive **bash** wizard from `template.sh` for human-only steps (secrets, dashboards, `gh secret set`). |
| setup-matt-pocock-skills | U | Per-repo config (above). |
| handoff | U | Compact handoff doc to the OS temp dir, with "suggested skills". |
| teach, to-questionnaire, wait-what | U | Learning workspace / questionnaire for someone else / re-pitch in plain English using CONTEXT.md. |
| writing-for-agents | M | Authoring principles (below). Replaces `writing-great-skills`. |
| *removed upstream* | | `resolving-merge-conflicts` (still in the local copies). |
| *misc (not shipped)* | | `git-guardrails-claude-code` (PreToolUse bash hook that **blocks `git push`**, `reset --hard`, `clean -f`, `branch -D`, `checkout .`), `setup-pre-commit` (Husky + lint-staged + typecheck + test), `migrate-to-shoehorn`, `scaffold-exercises`. |
| *in-progress* | | `loop-me` (workflow specs: trigger/checkpoint/"push right"/brief), `claude-handoff` (`claude --bg`), `setup-ts-deep-modules` (dependency-cruiser), **`software-factory`** (vocabulary: task/trigger/run/runner/orchestrator. "Every trigger is an accelerator", needing three brakes: automated checks, automated review, human review. "Cap every loop of runs at a few tries before a human."), `chief-of-staff`, writing-*. |

### Authoring principles: `writing-for-agents` (+ `SKILL-MECHANICS.md`). [mp] `skills/productivity/writing-for-agents/`
- The root virtue is **predictability**: the same *process* every run, not the same output.
- **Context pointer:** a description or AGENTS.md line is a pointer. Its *wording* decides when the target is reached. Front-load the leading word, one trigger per branch, cut identity the body already carries.
- **Two loads:** *context load* (always-loaded tokens) vs *cognitive load* (the human must remember user-invoked skills). Model-invoked = pay context load. User-invoked = pay cognitive load. A **router skill** cures cognitive load.
- **Information hierarchy:** in-file steps > in-file reference > disclosed reference (behind a pointer). **Progressive disclosure** = inline what every branch needs, push the rest behind a pointer. **Co-location** = a concept's rules sit together. **Sprawl** = too long even if every line is live.
- **Completion criteria:** every step ends on one. Clarity guards against *premature completion*; demand drives legwork. The strongest criteria are checkable and exhaustive. If an agent rushes, sharpen the criterion first, then split the sequence across a real context boundary (subagent or handoff).
- **When to split:** by sequence (hide post-completion steps) or by invocation (a distinct trigger word, or another skill needs to reach it).
- **Leading words:** pretrained compact concepts (*tight*, *red*, *tracer bullet*, *frontier*) that anchor behaviour. **Negation** backfires, so state the positive target.
- **Pruning:** a single source of truth. The **environment is a source of truth** (package.json scripts, config, `--help`), and a doc that restates it is a *cache*: cache only what lookup can't find. Hunt *sediment* and *no-ops* sentence by sentence.

---

## 7. Cross-tool portability

### Agent Skills spec. [spec]
- `name`: required, 1–64 chars, `[a-z0-9-]`, no leading/trailing/double hyphen, **must equal the directory name**.
- `description`: required, ≤1024 chars (Claude truncates at 1,536 combined).
- Optional: `license`, `compatibility` (≤500), `metadata` (string map), `allowed-tools` (experimental).
- Dirs: `scripts/`, `references/`, `assets/`.
- Progressive disclosure: ~100-token metadata, <5k-token body, resources on demand. References one level deep.
- Validator: `skills-ref validate`.

### Load paths by tool
| Tool | Project | User | Notes |
|---|---|---|---|
| Claude Code | `.claude/skills` | `~/.claude/skills` | plugins: `/<plugin>:<skill>` [skills] |
| Codex | `.agents/skills` (cwd → repo root) | `~/.agents/skills` | `/etc/codex/skills` admin. Invoke with `$skill` or `/skills`. `agents/openai.yaml` `policy.allow_implicit_invocation:false` makes a skill explicit-only. Follows symlinks. [codex-skills] |
| Cursor | `.agents/skills`, `.cursor/skills` | `~/.agents/skills`, `~/.cursor/skills` | **also reads `.claude/skills`, `~/.claude/skills`, `.codex/skills`**. Supports `disable-model-invocation`, `paths`. `name` must match the folder. [cursor] |
| Gemini CLI | `.gemini/skills` or `.agents/skills` (wins) | `~/.gemini/skills` or `~/.agents/skills` | `activate_skill` tool with a **user consent prompt**. `gemini skills install/link`. [gemini] |
| Copilot CLI/VS Code | plugin marketplace route per mp README | | **unverified** against GitHub docs |

- **The portable subset** is `name` + `description` + Markdown body + relative-path scripts. Claude-only constructs other tools ignore or mishandle: `` !`cmd` `` injection, `$ARGUMENTS`/`${CLAUDE_SKILL_DIR}` substitution, `context: fork`, `hooks`, `model`/`effort`, and `allowed-tools` semantics. `disable-model-invocation` is honoured by Claude and Cursor; Codex needs `openai.yaml`. Prose such as "Call the Skill tool with X" is Claude tool vocabulary, but other agents usually interpret it.
- **Hooks are not portable** as files. Claude `hooks.json` ≈ Codex `hooks.json` (similar JSON, `decision:block`, exit 2, `CLAUDE_PLUGIN_ROOT` env provided). Cursor and Gemini differ. Subagent files (`.claude/agents/*.md`) are Claude-specific.

### AGENTS.md vs CLAUDE.md. [agentsmd], [mem]
- AGENTS.md is plain Markdown with no required fields; the **nearest file wins**. It's stewarded by the Agentic AI Foundation (Linux Foundation). Named adopters include Codex, Cursor, Gemini CLI, Copilot coding agent, Jules, Aider, Zed, Warp, VS Code, Devin, Windsurf, Junie, Amp, RooCode and others. Recommended sections: overview, build/test commands, code style, testing, security, PR guidelines.
- Claude Code (≥2.1.277) reads `AGENTS.md` **only when no `CLAUDE.md`/`.claude/CLAUDE.md`/`CLAUDE.local.md` exists in cwd or above**. `~/.claude/CLAUDE.md` doesn't count. Setting `claude-md-and-agents-md` loads both. The robust pattern is a `CLAUDE.md` containing `@AGENTS.md` plus Claude-only extras; no double load. `@import` depth is 4 hops. Target <200 lines per file. Path-scoped rules go in `.claude/rules/*.md` with `paths:` frontmatter. **Adding a `CLAUDE.local.md` silently stops AGENTS.md from loading.**

---

## 8. Per-repo adaptation (how a universal skill finds repo commands)

Observed patterns, each with its source:
1. **Setup skill writes config docs plus a pointer block** in the existing CLAUDE.md/AGENTS.md (mp `setup-matt-pocock-skills` → `docs/agents/*.md`). Consumer skills reference "the issue tracker doc" in prose. The setup skill is the only way the config gets created, and editing it later is a plain file edit. [mp]
2. **Recorded-recipe skill:** `/run-skill-generator` commits `.claude/skills/run-<name>/SKILL.md` (install, env vars, launch). `/verify` records `.claude/skills/verify/SKILL.md` at the repo root (or per package in a monorepo), which then **replaces the bundled `/verify`**. It is edited only when the recipe steered a run wrong. [skills] This is Anthropic's own pattern: the universal skill is bundled and the repo-specific override is a same-named project skill.
3. **Environment as source of truth:** read `package.json` scripts, Makefile, CI workflow, and lockfiles directly. Don't duplicate them in docs (mp `writing-for-agents` "cache" rule). `retro` explicitly reads the repo's check command and CI workflow first. `wizard` reads `.github/workflows/*` for `secrets.*`. [mp]
4. **Invocation-time injection:** a universal skill can include `` !`cat .agents/verify.md 2>/dev/null || echo "NO VERIFY CONFIG: run /setup-verify"` `` so the repo config lands in the prompt deterministically. It's Claude-only, and a non-zero exit aborts the skill, hence the `||`. [skills]
5. **SessionStart hook** detects the stack (lockfiles, CI files) and emits `additionalContext`. It can also write env vars via `$CLAUDE_ENV_FILE`. [hooks]
6. **AGENTS.md "Build and test commands" section**: the cross-tool location every agent reads. [agentsmd]
7. **Monorepo:** nested `.claude/skills` and nested AGENTS.md give the closest-wins override. [skills], [agentsmd]

A config shape implied by the workflow (for the grilling session, not decided): one file (e.g. `docs/agents/verification.md`, which fits mp's `docs/agents/` convention) listing install, typecheck, lint, format, unit, coverage command and threshold, e2e, property/fuzz, mutation (optional), how to run the app, the CI provider with its watch/log/rerun commands, and the branch/PR/commit conventions. Pointed at from the `## Agent skills` block.

---

## 9. Recommended architecture options (opinion; for grilling)

**A. H7KZ/Agents = marketplace + one "core" plugin, Agent-Skills-compliant, mattpocock as a dependency** *(recommended starting point)*
- Layout: `.claude-plugin/marketplace.json` (`name: h7kz`) + `plugins/core/{.claude-plugin/plugin.json, skills/, agents/, hooks/hooks.json, scripts/*.mjs}`. Omit `version` so updates track commits.
- Authoring machine: `claude plugin marketplace add <home>/Documents/GitHub/Agents` (in place, live edits). Other machines: `claude plugin marketplace add H7KZ/Agents` with `autoUpdate: true` in `~/.claude/settings.json` `extraKnownMarketplaces`.
- Depend on `mattpocock-skills@claude-plugins-official` (cross-marketplace dependency, allowlisted), or simply document installing it. Don't vendor it. Remove the stale skills.sh symlinks and the desktop-upload copy.
- Hooks as exec-form `node` scripts (cross-OS). The Stop gate is registered via the **`/ship` skill's frontmatter `hooks`** so it's only active while the workflow runs.
- Other tools: the same `skills/` are spec-compliant (`name` = dir, plus `agents/openai.yaml`). Expose them via Codex/Copilot plugin install (if it reads `.claude-plugin`, unverified) or `npx skills add H7KZ/Agents`.
- Pros: one mechanism syncs skills, agents and hooks; namespaced (`/core:ship`) with no collisions with bundled or mp skills; auto-update; validator (`claude plugin validate --strict`) can run in CI.
- Cons: namespaced names are longer. Plugin agents can't carry hooks, MCP or permissionMode. Edits on other machines need a push and an update. Paths can't escape the plugin dir.

**B. Multi-plugin marketplace: core + stack packs**
- `core` (workflow, reviewers, gates) plus `stack-ts`, `stack-python`, `stack-dotnet`, `ci-github`, `ci-gitlab`, each its own plugin, enabled per repo via `.claude/settings.json` `enabledPlugins` (committed in each project) or via `relevance` suggestions. Optional `dependencies` from packs on core.
- Pros: per-repo opt-in. Small context load (fewer descriptions in the 1% budget). Stack-specific hooks only where they apply.
- Cons: more manifests. Every repo needs a settings commit plus `plugin install --scope project` on each machine ([load] "enabled in project settings but not installed").

**C. Plain skills repo, linked into `~/.claude/skills` + `~/.agents/skills` (mp `link-skills.sh` style) or the `@skills-dir` plugin trick**
- A clone or symlink of the plugin dir at `~/.claude/skills/h7kz/` with `.claude-plugin/plugin.json` loads **as a plugin in place** (hooks and agents included), and `git pull` is the update. The extra `~/.agents/skills` links give Codex, Cursor and Gemini native discovery.
- Pros: zero marketplace infra, live edits, best cross-tool reach.
- Cons: a manual pull per machine. Windows symlinks need Developer Mode, or use clones/junctions. No version pinning. Settings and hook merging fall to you if you don't use the skills-dir plugin.

**D. Bootstrap script + chezmoi/dotfiles-style sync**
- `install.ps1`/`install.sh` clones the repo, runs `claude plugin marketplace add`/`install`, links `~/.agents/skills`, and merges settings (autoUpdate, env such as `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, permissions).
- Pros: also handles settings, MCP and non-Claude tools in one place. Reproducible new-machine setup.
- Cons: you maintain a cross-OS installer. Settings.json merge needs care. It's best combined with A rather than replacing it.

A useful combination is A + D-lite: the plugin carries the content, and a tiny bootstrap only adds the marketplace, sets `autoUpdate`, and links `~/.agents/skills` for other tools.

---

## 10. Gaps in mattpocock/skills vs the user's workflow (opinion, grounded in the cited SKILL.md text)

| Workflow stage | mp coverage | Gap |
|---|---|---|
| Research | `research` (background agent, cited md) | Fine. It saves "where the repo keeps notes", so a convention for `docs/research/` is needed. |
| Grill (user decides architecture) | `grill-with-docs`, `grilling`, `domain-modeling`, ADRs | Fine. No explicit "architecture decision" output beyond ADRs; `to-spec` fills that role. |
| Implement w/ **staged commits** & self-run | `implement`: "Commit your work to the current branch" (once, at the end). `implement-spec`: per-ticket worktrees and merges | **No commit-granularity policy** (atomic commits per slice, conventional messages). **No "self-run"**: nothing invokes `/run`/`/verify` or drives the app. Bundled `/run`, `/verify`, `/run-skill-generator` cover this in Claude only. |
| **Exhaustive** test/verify (coverage, e2e, edge cases, property-based) | `tdd` deliberately **limits** scope: "Test only at pre-agreed seams… You can't test everything… instead of every edge case." Property/fuzz appears only as a debugging loop technique in `diagnosing-bugs`. | **Biggest gap.** No coverage measurement or thresholds, no e2e step, no property-based or mutation testing, no edge-case enumeration, no repo-specific test command discovery (setup covers only tracker, labels and domain docs). This directly conflicts with tdd's philosophy, so a separate `verify`/`harden` stage is needed instead of editing tdd. |
| Independent review | `code-review` (Standards + Spec, fresh parallel subagents); `implement-spec` runs it once plus **one** fix subagent | No security, performance or test-quality axis (Claude bundled `/security-review` and `/code-review` cover correctness and security). Reviewers aren't reusable `agents/*.md`. **No re-review after fixes.** |
| Loop fix until prod-ready | none (`retro` is post-hoc environment improvement; `software-factory` in-progress only *describes* "cap every loop at a few tries") | **No loop or termination criterion.** Candidates: a `/goal` condition generated from verification.md, a skill-scoped Stop hook gate, or an explicit review→fix→re-verify loop with a max-iterations brake. |
| PR/push + **watch CI** + loop on failures | `pr` writes the PR body only. `implement-spec` opens or readies a draft PR. `misc/git-guardrails-claude-code` **blocks `git push`**. | **No push, no CI watch, no CI-failure triage loop.** Building blocks exist outside mp: bundled `/loop` maintenance prompt (tends PR CI failures), `.claude/loop.md`, Monitor tool, Channels, `gh` CLI, `claude-code-action`. |
| Per-repo stack/CI adaptation | `setup-matt-pocock-skills`: issue tracker, labels, domain docs only | No discovery or recording of test/lint/e2e/coverage/CI commands. Needs a `setup-verify`-style skill or an extension block in `docs/agents/`. |
| Hooks / deterministic enforcement | Plugin ships **no hooks**. The only hook is the misc git-guardrails (bash) | No gates (pre-stop verification, secret scan, format-on-edit). The misc hook is bash-only, so on Windows it relies on Git Bash. |
| Windows | `wizard` and the misc hooks are bash. `improve-codebase-architecture` handles `%TEMP%`/`start` | Bash-dependent pieces. Prefer node or exec-form scripts for anything you ship. |
| Local install hygiene | — | Duplicate installs (skills.sh symlinks plus desktop plugin v1.2.3) with stale content. The personal `code-review` shadows bundled `/code-review`. Consolidate onto the official plugin v1.3.2+. |

Overlaps to reuse rather than rebuild: mp `grilling`/`grill-with-docs`, `to-spec`/`to-tickets`, `tdd` (inner loop), `code-review` (spec + standards axes), `diagnosing-bugs`, `pr` (body template), `retro`, `wizard`. Claude bundled `/verify` + `/run` (self-run), `/code-review`/`/security-review`/`/simplify`, `/goal`, `/loop`, `/batch`.
