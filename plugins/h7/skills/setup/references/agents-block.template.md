## Agent workflow (h7)

Trust comes from checks, not from reading diffs. Every correction becomes a deterministic check.

- Scope verification to what the change touches. Run the layers in `docs/agents/verification.md`.
- Show evidence (command and output, or a verify-skill run), not assertions.
- Ask before anything irreversible: deploys, pushes, deletes, migrations.

### Commands

- Install: `<install>`
- Check (what CI runs): `<full local check>`
- Test: `<unit>`
- Details, thresholds, CI watch commands: `docs/agents/verification.md`

### Rule <-> enforcer

| Rule | Enforcer |
|---|---|
| <rule the repo already states or configures> | <lint rule, type setting, test, CI job, or `none yet`> |

### More context

- Domain terms: `CONTEXT.md` (<present or "none yet">). Decisions: `<docs/adr or "none yet">`.
- Verify skills: `<.claude/skills/verify-<app>/SKILL.md, one per line>`.
