# Agent trust layer: source research

Date: 2026-11-15. Purpose: inputs for a modular, cross-repo, cross-harness skill/script/hook system (H7KZ/Agents) covering research → grill → implement → verify → review → loop → ship/CI-watch.

Relevance key: **[A]** directly applicable, **[P]** partially applicable, **[F]** enterprise-governance fluff / marketing.

pstack pinned at commit `bf0c7cd8` (2026-11-14), version 0.15.42. `P/` below = `https://github.com/cursor/plugins/blob/main/pstack/`.

---

## 1. Lauren Tan, "All Code Is Slop (Except Mine)" [A]

Source: transcript `C:\Users\honzi\Downloads\All Code Is Slop (Except Mine) — Lauren Tan, SpaceXSI.txt`; video https://www.youtube.com/watch?v=O_zcc6Xl12g (title confirmed; channel, date, description not retrievable via fetch).

- Inverse pyramid of where to invest: (1) code/API design/architecture, (2) lint/types/compilers/tests, both deterministic; (3) runtime + formal verification; (4) prose (rules, skills, AGENTS.md) last, only for judgment.
- Core rule: every agent correction becomes a deterministic check or an API/architecture change that eliminates the class, not another AGENTS.md line. "Do enough and there's nothing left to review."
- Codebase is the biggest agent input; agents copy anti-patterns, deprecated code, workarounds. Keep it pristine ("gardening").
- Ban nuance-heavy APIs outright (e.g. `useEffect` banned in product code, allowed only inside framework APIs). Context via directory structure (`electron-main/` vs `electron-renderer/`, cross-imports banned by dep-graph analyzer + lint).
- Ban ~99% of comments: they go stale, are unenforceable, and give agents a place to justify workarounds. Lint errors must name the root-cause fix.
- Code review shrinks to reviewing verification artifacts: videos, screenshots, diagrams, formal verification results.
- Runtime verification = agent runs the code itself with human debug tools (CDP). Feature map = user-POV site map of features → shared vocabulary. Custom CLIs inside skills = reusable, token-cheap, testable drivers.
- Formal: TLA+ for multi-device notification flows; Lean for custom virtualization (no flicker/jitter). Property-based UI testing with Bombadil. ~70% of tokens go to verification.
- Outcome claims: 11k PRs/month team, revert rate ~0.5%, perf improved. Release pipeline auto-fuzzes the build, opens fix PRs, auto-merges.
- Sequencing advice: lint rule to block new occurrences → clean old ones → strong verification → only then automate the outer loop ("automating a slop loop yields more slop").

## 2. cursor/plugins `pstack` (Lauren Tan) [A], most important

Repo: https://github.com/cursor/plugins/tree/main/pstack. MIT. Manifests: `P/.cursor-plugin/plugin.json`, `P/plugin.json` (agent-plugins.org schema). Read every SKILL.md, all playbooks, agents, guide pages 06/07/09/10, the Claude Code adapter, benny automation pack, and the scripts' structure. The statechart test corpus (TLA+ golden files) was skimmed, not read file by file.

### 2.1 Architecture of the pack

- One router skill (`poteto-mode`) + 23 playbooks + ~40 situational skills + 24 one-rule "principle-*" skills + 2 subagent definitions. Source: `P/README.md`.
- Nearly every skill has `disable-model-invocation: true`: skills run only when invoked by name or routed by `poteto-mode`. Descriptions front-load trigger phrases. Source: each `P/skills/*/SKILL.md` frontmatter.
- Principles are tiny leaf skills so other skills cite them by name; router keeps an inline index and requires the agent to read a leaf before citing it. Source: `P/skills/poteto-mode/SKILL.md` ("Principles").
- Model roles are config, not code: `/setup-pstack` writes one always-applied rule (`~/.cursor/rules/pstack-models.mdc`, or `~/.claude/rules/pstack-models.md`) mapping roles (feature, bug-fix, hardest tasks, swarm workers, arena runners, cross-judge pool, interrogate reviewers...) to models + a budget knob. Skills fall back to defaults when absent. Source: `P/skills/setup-pstack/SKILL.md`.
- Cross-harness: Cursor names are canonical; `P/docs/harness/claude-code.md` maps tools (`Task`→`Agent`, `AskQuestion`→`AskUserQuestion`), subagent fields (`readonly:true`→`Explore`, `environment:"cloud"`→`isolation:"worktree"`), models, paths, transcripts, and says "Skipped in Claude Code: <step>" for Cursor-only features. A generator (`scripts/generate-pstack-harness-trees.mjs` at repo root) emits `harness/pstack/claude-code/` by regex-scanning skills for Cursor-specific terms; CI fails if the generated tree is stale. Source: https://github.com/cursor/plugins/blob/main/scripts/generate-pstack-harness-trees.mjs.
- Bundled scripts are self-bootstrapping: `watch-pr` runs under bun, hashes `package.json`+`bun.lock` into an install key, runs `bun install --frozen-lockfile` only when the key changes. `statechart` shell shim picks Node ≥22.18/23.6, Bun ≥1.1.5, or Deno ≥2. Sources: `P/skills/poteto-mode/scripts/bootstrap.ts`, `P/skills/statechart/scripts/statechart`.

### 2.2 Router: `poteto-mode`

Source: `P/skills/poteto-mode/SKILL.md`.

- First message on any task: restate goal, problem, smallest expected change; don't wait for confirmation. Restate goal in every subagent brief, every PR `## Why`, every final report.
- Before asking the human a "which approach" question: classify it. If a run could answer it (behavior, timing, layout, perf), prototype instead. Ask only for product/preference calls no experiment settles. This is the "grill the user only on real decisions" filter.
- Matches task to a playbook, copies its steps verbatim into a todo list; skipped steps stay with `skip: <reason>`.
- Trigger table routes to skills: code → name the data shape first; crossing a function boundary → `architect`; contested design → `interrogate`; before commit → `deslop`; before review → `no-comments`; UI/CLI → `control-ui`/`control-cli` (in cursor-team-kit, not pstack); any measured number → `benchmark-checklist`; long/unattended → `show-me-your-work`.
- Autonomy: reversible work proceeds; always pause for force-push to shared branches, deploys, data deletion, customer messages. "No" is an acceptable answer; candor over sycophancy.
- Subagents: fresh subagent per new work item with consolidated scope (brief + later directives + prior report); resume only when state is costly to move. Verification runs on the cheap fast model. Parent owns and reviews every diff; "a second opinion is the same prompt against a different model; agreement is high-signal".
- Reply rules: every claim labeled measured / inferred / guess; never hand the human a check you could run; never fabricate links.
- Comments: keep only non-obvious *why*; test scripts carry no phase comments, assertion strings document steps.

### 2.3 Playbooks (all in `P/skills/poteto-mode/playbooks/`)

| Playbook | Purpose / mechanism |
|---|---|
| investigation | read-only cited answer (Overview / Key Concepts / How It Works / Where Things Live / Gotchas) |
| bug-fix | reproduce yourself on the real surface; binary-search hypotheses with runtime evidence; failing repro commit lands before fix commit; paste failing-then-passing output |
| feature | trace subsystem → `architect` → 4-item "throughput checkpoint" (blocking first steps, independent workstreams, shared mutable state, smallest decomposition) → mandatory delegation (review separation) → verify on matching surface → small ordered commits → `interrogate` if contested |
| refactoring | pin behavior first (characterization test/snapshot/equivalence harness; "type check and lint are not a pin"); subtract first; equivalence proof; revert if reader load didn't drop |
| prototype | throwaway in scratch dir; variants behind one switcher; observation is the test |
| perf-issue | baseline trace; mantras in order (don't do it / don't do it again / do less / later / when not looking / concurrently / cheaper) |
| hillclimb | frozen measurement harness (sensitivity-proven, prints error + work counts); one hypothesis per iteration; keep/revert; `decision.tsv`; stop predicate = target + minimum attempts |
| runtime-forensics / trace-forensics | live instrumentation vs captured artifact; dump traces to sqlite, query |
| visual-parity | screenshot baseline first; no harness/baseline tampering; nonzero image diff = fail |
| authoring-a-skill | validate frontmatter, referenced files, cross-skill links; tests if structural |
| eval | blinded skill/prompt A/B: no eval words in candidate env, organic prompt, judge on other model family, grade chain-following from transcripts not self-report |
| babysit | modes `drive`/`background`/`threads-only`/`check`; only the lowest unmerged PR matters; order: conflicts → review threads → CI; classify CI failure before retry (flake = 1 fresh build max; failure in untouched code = stale base, check `git merge-base --is-ancestor`); triage bot comments skeptically; never merges |
| shipping | independent verifier per PR (never the author) posts PASS/PASS+NOTES/FAIL; land only the contiguous verified run from the bottom; re-validate verdicts via `git patch-id` after rebases; read PR back after merge (queue ≠ merged) |
| autonomous-run | checkable exit predicate; event watcher + heartbeat; smallest change per iteration, revert non-helping; plateau ≠ stop; never relax predicate |
| orchestrate / autopilot-full / autopilot-stack | one owner per PR; verifier on different model family; swarm-verify once at code-ready head, single verifier after rebase/minor fix; hourly audit tick judges agents by side effects (pushes, trail rows), not status text |
| multi-phase-plan | plan as a checklist; every box names its evidence; per-PR blocks Files/Build/You see/Verify unit/Verify live (10 lanes incl. regression-vs-trunk)/Verify perf/Review gate/Merge; enforced by `check-plan.mjs` linter |
| session-pickup / pause-safely | trail is authoritative, don't redo; `wip:` commit + resume note |
| opening-a-pr | worktree off main; small ordered commits; Conventional Commits title; body sections Why / What changed / Scope / Tradeoffs / Blast Radius / Verification; open ready not draft; don't babysit on open |
| worktree-cleanup | `worktree-audit.sh` read-only classifier; deletion human-gated |

Scripts (`P/skills/poteto-mode/scripts/`):
- `watch-pr/` (TypeScript, bun, commander, ~120KB incl. tests): GitHub PR watcher via `gh`; JSON by default, `--pretty`, `--status-only`, `--stack`, `--queued-stack --stack-prs`; emits typed verdicts `READY` / `WAITING` (pending-checks | merge-queue) / `ADVANCE` / `COMPLETE` / `BLOCKED` with blocker kinds (merge-conflicts, review-threads, failing-checks, merge-gate, status-query failures). Branded `PrNumber`, discriminated unions. Has `policy.test.ts`, `github.test.ts`, `cli.test.ts` with fakes. Directly reusable model for step 7 (CI watch loop).
- `check-plan.mjs` + test: lints plan markdown for required headings, sub-blocks, verification rule sentence, lane count. Example of "encode the template as a checker".
- `worktree-audit.sh`: classifies worktrees by size, merge state, uncommitted work, PR state, newest chat.
- Bugbot rubric `P/skills/poteto-mode/references/bugbot-triage.md`: classify bot comments fix / dismiss / ask; learned dismissal patterns with confidence candidate → recurring → strong; never dismiss security/auth/billing/data/migration.

### 2.4 Verification skills (the core of the talk)

- `create-verification-skill` (`P/skills/create-verification-skill/SKILL.md`): generates project-local `.cursor/skills/verify-<app>/`. "Interview the repo, not the user": surface, run, drive (existing Playwright/Cypress/PTY/curl first, else CDP / tmux-PTY / HTTP), observe, isolate. Required sections: **Launch** (from empty data dir, "ready means usable"), **Doctor** (read-only "is this instance worth driving?"), **Drive** (real selectors, stable handles), **Evidence** (real user path, action + resulting state, side effects, mocks only at production boundaries, verify dry-runs by observation), **Cleanup** (kill only what you started; evidence survives), **Helpers** (executable, invocation shown). Must be proven end to end once before handoff; evidence must survive cleanup.
- Feature map (`P/skills/create-verification-skill/references/feature-map-example/`): `features/README.md` (baseline preconditions, driving conventions, proof/skip reporting rules, entry contract) + one file per feature with exactly four H2s: `Sub-features` (short IDs), `How to get to it (user POV)` (every entry point), `Driving it with <harness>` (Preconditions + labeled bullets pairing user action ↔ exact CLI command ↔ observable result + Proof step saving ARIA snapshot + screenshot), `Gotchas`. Rules: never weaken a journey to pass; skipped entry point ≠ verified via another path; CLI proof = command, stdout, stderr, exit code; mutation proof = read-only second view.
- `maintain-verification-skill`: outcomes clean / changed / blocked; one read-only source-reader subagent per feature file, then one live pass driving every feature; triage doc drift vs harness gap vs product regression (report, never paper over); edits only the verify skill dir; at most one PR.
- `create-formal-verification-skill`: pick the strongest target (promise where breakage harms users and tests rarely reach), not the easiest. Tool by question: ordering/concurrency → model checker, TLA+ default; per-input code behavior → code-level verifier; no verifier for the language → generated-input testing on the real code; unbounded → proof. Rules: true to code (each model step = one atomic code step, cite files); **able to fail** (show each property failing on a broken variant); findings stay findings (never weaken property); honest scope/bounds; one-command rerun; record covered files + **sync commit**. Prove the generated skill catches a scratch break.
- `maintain-formal-verification-skill`: run as-is first; diff covered code since sync commit (incl. renames/moves/new writers of guarded state); classify each change (no effect / model stale / promise changed on purpose with cited evidence / promise maybe broken); update from code before rerun; on pass, break it again to prove it can fail; on fail, replay counterexample against real code → modeling error vs bug; outcomes in sync / updated / bug / blocked.
- `statechart` (`P/skills/statechart/SKILL.md`, `references/render.md`, `scripts/`): `statechart SPEC.tla [--config] [--view] [--out]` runs TLC (auto-installs Java+TLC via mise), draws a Mermaid statechart from the explored state graph in the reader's words. Reader's rules = INVARIANTs. A JS "view" module exports `state(vars)` (string = flat, array = nested, object = parallel regions), `step(action, from, to)` labels in user words, `group`, `colors`, `title`. Marks states `breaks` / `mayBreak`, `bugPath`, `repeats`; report gives shortest path to each violation; iteratively removes broken rules and reruns (100k state cap after first break), lists "Rules not checked". 500-state chart budget; aim ≤20 arrows. Render SVG with `pele@1.9.0`. Exit 0 all hold / 1 rule breaks / 2 error. Hand-off requires replaying each bug path against real code. Implementation is a small compiler: frontends (spec, config, dot, trace, view) → IR → passes (reach, regions, label, lift, loop-check, region-check, paths, annotate) → backends (mermaid, report, cfg, plain-text). Tested with fast-check property tests, config fuzzing (4000 configs), differential tests against real TLC + a Java oracle, golden corpus (33 specs). Itself a showcase of the talk's method.
- `benchmark-checklist`: 7 questions before reporting a number (limiter / "why not double?", tuned like prod, physical limits, errors counted, ≥5 alternating runs with median+range, end-to-end relevance, did the work happen); verdict faster / slower / no measurable difference / inconclusive.
- `blast-radius`: find the one fact the change is safe because of; certainty ladder (said so → file:line → walked failure → ran it → reproduced in app); prove with a script calling the real code.
- `tdd`: failing test first only when cheap; "prefer no new test over a bad test".
- Principle `test-behavior-not-implementation`: keep a test only if it fails when behavior breaks and passes when internals change (two imagined edits).

### 2.5 Review / adversarial skills

- `interrogate`: N adversaries on different models in isolated worktrees try to break the diff; a finding survives only with a command + output that the parent reruns; no style/naming/speculative findings; outputs Intent / Findings / Dropped counts. Matches the user's step 5.
- `arena`: N candidates, same prompt, rubric hidden from candidates, cross-judge from a different vendor, pick base by rubric, graft 1-2 pieces from losers by hand, then verify. Divergence = under-specified frame → reframe.
- `architect`: ground (trace + `why`) → arena of ≥2 structurally distinct sketches (types, signatures, `not implemented` bodies, caller usage first) → screen against `references/design-red-flags.md` (shallow module, information leakage, temporal decomposition, pass-through, split ownership, two ways to do one task, importable internals, hand-synced lists) → optional human checkpoint → implement against sketch → scrap on repeated friction patterns. Rationale template: Problem / Usage / Shape / Synthesis / Tradeoffs / Alternatives / Open questions / Next step.
- `swarm`: N workers, partition or race; reports PASS / ISSUES / BLOCKED with evidence; workers must record SHAs + method or get respawned; gaps ≠ passes.
- `no-comments` + `agents/comment-sicko.md`: subagent deletes comments except license, external-constraint, public API docs, issue links; flags workaround symbols `MUST KILL`; constraint comments ("do not remove") get offered as type/runtime/test/lint encodings, then deleted.
- `show-me-your-work`: append-only TSV `ts phase decision why evidence result`; `scripts/log.sh` sanitizes tabs/newlines and spreadsheet-formula prefixes; run-boundary `start` rows; end-of-run audit of log vs transcript; cross-model review → mandatory "Attention" section naming reviewer model.
- `figure-it-out`: bespoke playbook for big/unattended work: falsifiable done predicate, rigor level, verification harness with baseline before work, hypothesis loop, VERIFIED / NOT VERIFIED / INCONCLUSIVE.

### 2.6 Learning loop skills

- `correct` (`P/skills/correct/SKILL.md`): mine commits, reverts, review comments, instruction files, workaround comments → mistake classes (count once seen twice) → fix at highest level: architecture → types → lint/CI check whose error names the fix (if pattern already common, fail only on additions) → behavior test → docs last. Prove each check fails on a real past mistake; same command locally and in CI; exceptions inline with reason + expiry + human approval. Keep a **rule ↔ enforcer table** in the agent instruction file; a rule with no enforcer that recurs gets escalated. This is Tan's core rule as a skill.
- `reflect`: 3 parallel transcript reviewers (judgment, tooling incl. "user supplied context the agent could have fetched", divergent) + synthesizer → Accepted / Rejected / Backlog; anything a lint/script could enforce moves to Backlog; user approves row by row; never edit plugin cache.
- `automate-me`: mine transcripts in slices, ask structured multi-choice questions, cluster, draft a personal `<handle>-mode` skill; require ≥2 occurrences before codifying.
- `recall`: rebuild context from own transcripts (parallel slice miners) + shared record (git, tracker, error tracking), verify against live `git`/`gh`, brief with status-tagged threads.

### 2.7 Comms / prose skills

`unslop` (numbered anti-AI-tell rules, stable IDs), `technical-writing` (Diátaxis + Google style + STE + Global English), `ketchup` / `ketchup-video` (catch-up with decidable action items, visuals), `bro`, `teach`, `how`, `why` (answer from commits/PR record, mark inferences), `in-your-own-words`, `sharpen` (prompt deepening), `poteto-help`, `typescript-best-practices` (`paths: ["**/*.ts","**/*.tsx"]` path-scoped trigger), `make-bot-ui` (Grok Bot webhook UI, irrelevant). Sources: `P/skills/<name>/SKILL.md`.

### 2.8 benny automation pack (dormant, Cursor-only)

Source: `P/automations/benny/`. Slack report → triage automation posts marker `[benny:bug|performance|other]` → repro automation. Reusable ideas: **control-adapter contract** (`references/control-adapter.md`) with 7 required capabilities (bring up, navigate mapped features, drive real UI, inspect without mutating, screenshot, record video, clean up), fail closed if any missing; symptom must reproduce twice via real UI, state inspection may confirm but never inject; existing fix PR switches to verify mode; no repro → no fix; draft PR only after before/after proof; children never get write credentials.

### 2.9 Guide takeaways

- Overnight contract = goal + finish predicate + isolated worktree + permissions + escape hatch; "a duration is not a finish condition". Earn the loop first (done by hand once, agent has your tools, every stage can stop the line, failures turned into checks). Source: `P/docs/guide/07-overnight.md`.
- Control CLI traits for agents: few composable commands, `--dry-run` on destructive ops, progressive subcommands, errors that say what to do, rich `--help`, JSON output; plus one-command reproducible dev env with seed data. Source: `P/docs/guide/06-verify-and-ship.md`.
- Pitfalls: listing skills in the prompt, vague finish conditions, leading with your theory, taking the first design, adversarial review of a plan with no code, parallel agents in one worktree, looping before the loop verifies itself. Source: `P/docs/guide/10-recipes-and-pitfalls.md`.
- "Start smaller than you think… add a skill or check when the same failure shows up twice." Source: `P/docs/guide/09-make-it-yours.md`.

### 2.10 Dependencies not in pstack

`deslop`, `control-cli`, `control-ui` live in `cursor-team-kit` (not read). Cursor-only: Bugbot, cloud agents, automations, `/loop`, built-in PR tool. Source: `P/README.md` ("not shipped here").

## 3. Bombadil (Antithesis) [A]

Repo: https://github.com/antithesishq/bombadil (Rust, MIT, ~2k stars, latest v0.7.10, 2026-10-21). Manual sources: https://github.com/antithesishq/bombadil/tree/main/docs/manual/src. Background: https://wickstrom.tech/2026-01-28-there-and-back-again-from-quickstrom-to-bombadil.html (Quickstrom lineage; not read).

- Property-based testing / fuzzing for **web (browser) and terminal UIs**. Explores by generated actions; checks properties in every reached state.
- Specs in TypeScript (`npm i -D @antithesishq/bombadil`). `extract(state => …)` builds `Cell<T>` from DOM (`state.document`, `state.window`) or terminal grid (`state.grid.rowText(0)`, `state.exitStatus`).
- LTL-style operators: `always`, `eventually`, `next`, `now`, `.and/.or/.implies`, `not`; time-bounded guarantees; example state-machine property `always(unchanged.or(increment).or(decrement))`.
- Action generators: `actions(...)`, `weighted([...])`, `.map`, `.flatMap`, `.when(cell)`; custom actions with DOM access.
- Defaults (`export * from "@antithesishq/bombadil/browser/defaults"`): no uncaught exceptions, no unhandled rejections, no error logs, no HTTP 4xx/5xx; navigation + semantic-element interaction. Terminal defaults: exit 0, no replacement chars. Optional `noResourceLeak` (heap / DOM sliding window).
- CLI: `bombadil browser test <url> [spec.ts] --time-limit=1m --output-path X`, `bombadil terminal test --specification=spec.ts <cmd>`, `--reproduce=<trace>`, `shrink` (experimental, calibrates flakiness), `browser inspect <trace>` (web viewer), `bombadil trace <trace> --screenshots DIR | --json | --state 40..50 | --screen`.
- CI: `antithesishq/bombadil-action@v2` (`driver`, `origin`/`command`, `specification`, `time-limit`, `exit-on-violation`, `output-path`); Docker `antithesishq/bombadil:<ver>`; Nix.
- Fit: traces + screenshots are verification artifacts; `--json` trace output is agent-parseable; terminal driver covers CLI/TUI repos, not just web.

## 4. AgentTrust (arXiv 2606.08539v1) [P]

Source: https://arxiv.org/html/2606.08539v1. Single independent author, June 2026 preprint, not peer-reviewed; curated corpora + replay, small external set (189 actions).

- Per-action gate on agent tool calls (shell, cloud, DB, package installs) returning allow / warn / block / review before execution.
- Split threats: **lexical** (stable signature → deterministic rules; shell normalizer de-obfuscates; 170-rule engine) vs **semantic** (benign twin exists; depends on destination/scope/intent → LLM judge).
- Rules out-of-distribution: 48.1% acc, 22.4% FPR; LLM judges 83.6-85.2%. Hand-written cloud/CI/K8s rule pack: 48→56%, semantic categories unmoved.
- Judge escalations accepted only above per-provider confidence threshold; ungated judge raises FPs.
- Judge-as-teacher: distill judge verdicts on lexical cases into new deterministic rules (judge-call rate 50%→44% over replay). Same pattern as Tan's "correction → deterministic check".
- Memory of precedents stored only when two judges agree (semantic acc 70→84%; ungated +2pp). Invariant: never hard-block benign; worst case warn/review (0 benign hard-blocks / 45k actions).
- Fit: maps to a PreToolUse hook: regex floor for destructive commands, optional LLM review for ambiguous ones, log judged cases → promote to rules.

## 5. Thoughtworks, "How to cultivate trust with AI coding assistants" [P]

Source: https://www.thoughtworks.com/insights/blog/generative-ai/how-to-cultivate-trust-with-AI-coding-assistants (Jiaming Shang, 2025-08-28). Team-adoption framing; some fluff.

- Evaluate assistant on Performance (context, time, quality, consistency), Process (plans first, asks clarifying questions, follows team practices, interruptible, permission controls, easy environment restore), Purpose (hallucination, data security, compliance).
- Classify each failure (SRK): slip (right intent, wrong execution) / rule-based (skipped workflow, e.g. TDD) / knowledge-based (missing context). Route fix: knowledge → instructions/context; rules → team rules/skills; purpose → tooling/model choice.
- Repo instruction file in three parts: knowledge (architecture, guidelines, stack), rules (define problem, plan, TDD), skills. After each failed task, add the missing knowledge/rule/skill.
- Tag commits/stories that used the assistant to measure real efficiency.
- Contrast with Tan: Thoughtworks stops at prose instructions; Tan says prose is the last resort. Use SRK classification to decide which layer the fix goes to.

## 6. Netlify, "How to trust what ships when you didn't write the code" [P]

Source: https://www.netlify.com/blog/how-to-trust-what-ships-when-you-didn-t-write-the-code/ (no author; metadata updated 2026-11-15). Product-adjacent.

- Review agent changes in a deployed preview, not only the diff.
- Keep build/deploy logs and audit trails linking each agent action to its source.
- Required human sign-off; don't auto-merge agent PRs (directly contradicts Tan's end state; reasonable before verification is trusted).
- Every deploy reversible (rollback path).
- Green tests insufficient for sensitive paths (auth example): also preview + logs + rollback plan.

## 7. Collibra, "AI trust layer command center" [F]

Source: https://www.collibra.com/blog/the-ai-trust-layer-command-center-architecture-for-enterprise-grade-models-and-agents. Product blog, no implementation detail.

- Components: registry of all models/agents (owner, risk tier), governed context (lineage, definitions), policy-as-code at data layer, observability (drift, decision traces), single trust score gating production.
- Only transferable idea for a solo dev: policy as code, not documentation; one readiness signal that gates shipping.

## 8. Cyera, "Identity meets data: AI trust layer" [F]

Source: https://www.cyera.com/blog/identity-meets-data-defining-the-ai-trust-layer-for-the-agentic-enterprise. Acquisition marketing.

- Inventory non-human identities (service accounts, tokens, agents) and the data each reaches; prioritize by data sensitivity; right-size, rotate, task-scoped access; decide at point of action.
- Vendor stat: workers use ~4% of granted permissions (unverified).
- Transferable: least-privilege tokens for agents (e.g. fine-grained `gh` token per repo, no prod creds in agent env).

## 9. NHI Mgmt Group glossary, "Agent trust layer" [F]

Source: https://nhimg.org/glossary/agent-trust-layer/. Glossary checklist.

- Four parts: identity proofing, authorization, per-request policy enforcement, telemetry. Map to NIST SP 800-53 IA-9, AC-6, AU-6; OWASP ASI02 (validate tool calls before execution).
- Per-action trust, not per-session; keep evidence for each allow/deny; on abnormal telemetry reduce privileges or require step-up.

## 10. Blocked sources

- Medium, "The verification layer every AI agent needs, and how I built one twice" (Ali Süleyman Topuz): https://topuzas.medium.com/the-verification-layer-every-ai-agent-needs-and-how-i-built-one-twice-f60dfb2c1164 → HTTP 403 to WebFetch, Cloudflare JS challenge to curl, archive.org refused, not in the author's RSS (last 10 items). The feed shows related posts (noise bands for agent evals, risk-tier gate for agent PRs measured in human review minutes, decision model as a gate), so the author's work is likely relevant. **Read manually.**
- Reddit r/AI_Agents thread 1xrj3ge: https://www.reddit.com/r/AI_Agents/comments/1xrj3ge/how_to_enhance_the_trust_factor_of_an_ai_agent/ → WebFetch blocks reddit domains; curl 403. Not read.

---

## Synthesis: concrete patterns for a solo dev's cross-repo skill system

Mapped to the user's workflow steps (1 research … 7 ship/CI).

1. **Two-tier layout: universal skills in H7KZ/Agents, generated project-local skills in each repo.** pstack's universal skills (`create-verification-skill`, `create-formal-verification-skill`, `correct`) *generate* repo-specific artifacts (`verify-<app>/` with feature map, formal verify skill with sync commit, lint rules + rule↔enforcer table). The universal layer stays stack-agnostic; stack knowledge lives in the repo. Sources: §2.4, §2.6.
2. **Router + playbooks + leaf principles.** One entry skill matches the task to a playbook and copies steps verbatim into a todo list (skips recorded with reasons). Encode the user's 7-step workflow as playbooks (feature, bug-fix, refactor, investigation, ship). Keep principles as tiny named leaves so playbooks cite instead of restate. Source: §2.2, §2.3.
3. **Explicit invocation by default.** `disable-model-invocation: true` + trigger-front-loaded descriptions + path-scoped skills (`paths:`) avoid accidental triggering across many repos. Source: §2.1, §2.7.
4. **Canonical skill source + generated per-harness trees + CI drift check.** pstack writes Cursor-canonical skills, maps them via an adapter doc, generates the Claude Code tree, and fails CI if the generated tree is stale. Same for H7KZ/Agents: one source → Claude Code / Cursor / Codex outputs, with a sync/install script that is idempotent. Source: §2.1.
5. **Model roles as a config file, not hard-coded.** One per-machine rules file maps roles (implementer, verifier, adversary panel, cross-judge) to models + budget; skills fall back to defaults. Keeps skills portable across machines/plans. Source: §2.1 `setup-pstack`.
6. **Step 2 (grill) filter.** Before asking the user, classify: if a run or prototype can answer it, prototype; only product/preference calls go to the user. Pair with `architect` rationale template "Open questions and risks" as the grilling agenda. Sources: §2.2, `P/skills/architect/references/rationale-template.md`.
7. **Step 3 (implement): data shape first, staged commits that tell a story.** Failing repro/test commit before the fix; subtraction commit before reshape; baseline before treatment. Throughput checkpoint before fan-out; one worktree per parallel agent. Sources: §2.3 bug-fix, feature, `principle-sequence-verifiable-units`.
8. **Step 4 (verify): build a verification skill per repo with a feature map + control CLI.** Launch / Doctor / Drive / Evidence / Cleanup / Helpers; feature files with four fixed H2s; proof = action + resulting state + side effects; evidence survives cleanup; proven once before use. Make the driver a small JSON-emitting CLI with `--dry-run` so agents reuse it cheaply. Sources: §2.4, §2.9.
9. **Step 4 test-quality gates beyond coverage.** "Two imagined edits" test audit (break behavior → test must fail; change internals → test must pass); mutation testing would automate the first half (my inference, not in sources). Property-based tests (fast-check / Hypothesis / proptest) for logic; Bombadil for web/TUI state space; differential testing against an oracle; golden corpus. statechart's own test suite is a working template. Sources: §2.4, §3, `P/skills/principle-test-behavior-not-implementation/SKILL.md`.
10. **Formal verification as an opt-in skill with a staleness record.** Pick the highest-harm untested promise; TLA+ for ordering, code verifiers for per-input, proof for unbounded; show each property failing on a broken variant; record covered files + sync commit so a hook/CI can flag "verified code changed since sync". Render TLA+ results as user-language statecharts for review. Source: §2.4.
11. **Verification artifacts replace code review.** Every PR body: Why / What changed / Scope / Blast Radius / Verification (real run path + outcome) + screenshots/video/trace links. A checker script lints PR bodies/plans for required sections (`check-plan.mjs` pattern). Sources: §1, §2.3 opening-a-pr, multi-phase-plan.
12. **Step 5 (review): adversarial, run-proven, different model.** `interrogate`: adversaries in isolated worktrees must attach command + output; parent reruns; drop unproven findings; reviewer ≠ author. `no-comments` pass and `blast-radius` "one safety fact proven by a script". Sources: §2.5, §2.4.
13. **Every correction becomes a check (`correct`).** Levels: architecture → types → lint/CI with fix-naming error (ratchet: fail only on new occurrences) → behavior test → prose. Prove each check fails on a real past mistake. Keep a rule↔enforcer table in AGENTS.md; unenforced recurring rules escalate. Sources: §1, §2.6. Thoughtworks SRK classification (§5) helps pick the level.
14. **Session learning loop.** `reflect`-style post-task review with separate lenses; anything enforceable goes to a backlog of checks, not skill prose; user approves skill edits row by row. Source: §2.6.
15. **Decision trail for unattended loops.** Append-only TSV (ts, phase, decision, why, evidence, result) via a sanitizing `log.sh`; audit against transcript at end; cross-model review → "Attention" section. Source: §2.5 `show-me-your-work`.
16. **Step 6 loop discipline.** Falsifiable predicate up front; one change, one check, keep/revert, one log row; plateau ≠ stop; never relax the predicate; verdicts are VERIFIED / NOT VERIFIED / INCONCLUSIVE (inconclusive ≠ pass). Sources: §2.3 autonomous-run, hillclimb, `figure-it-out`.
17. **Step 7 (ship + CI watch): typed watcher CLI + babysit rules.** Port the `watch-pr` design: `gh`-based, JSON verdicts (READY/WAITING/BLOCKED/…) with blocker kinds; agent loop rearms after each push. Order conflicts → threads → CI; classify failures before retry (flake gets one fresh run; failure in untouched code = stale base); batch fixes into one push; skeptical bot-comment triage with a learned-pattern rubric. Verdict validity across rebases via `git patch-id`. GitLab/other CI needs an adapter behind the same verdict type. Sources: §2.3 babysit, shipping, `watch-pr`.
18. **Hooks for the deterministic layer (Claude Code).** Not in pstack, but implied by Tan + AgentTrust: PreToolUse hook with regex floor for destructive commands (force-push, rm -rf, prod deploy) → block/ask; PostToolUse/Stop hooks run the repo's fast checks (lint/types/affected tests) and feed failures back; log ambiguous cases for promotion to rules. Sources: §1, §4.
19. **Fail closed on missing capabilities.** If the repo lacks a driver, feature map, or required capability, mark verification blocked/inconclusive instead of substituting a weaker proof. Never inject state to fake a repro. Source: §2.8.
20. **Least privilege for agents.** Fine-grained tokens per repo, no prod creds in agent env, always-pause list for irreversible ops. Sources: §2.2 Autonomy, §8, §9.

## Open design questions the user must decide

1. **Harness targets.** Claude Code only, or also Cursor/Codex/others? Determines whether to adopt pstack's canonical-source + generated-trees + adapter approach or write Claude-native only.
2. **Reuse vs fork pstack.** Install pstack as a dependency (it supports Claude Code via `/plugin install pstack@cursor-plugins`), vendor-fork selected skills (MIT), or only borrow patterns? Fork means owning upkeep; dependency means accepting poteto's style and Cursor-centric naming.
3. **Sync mechanism across machines.** Git clone + symlink into `~/.claude/skills`, a Claude Code plugin marketplace from H7KZ/Agents, or an install script? Per-machine config (model roles, tokens) kept out of the repo?
4. **Universal vs project-local split.** Which artifacts live in each target repo (verify skill, feature map, lint rules, rule↔enforcer table, formal checks) and are they committed there? Committing them changes every repo you touch.
5. **Invocation policy.** Explicit-only (`disable-model-invocation`) vs auto-triggered skills vs hooks that always run. How much runs without being asked?
6. **Hook strictness.** Which hooks block (exit 2) vs warn, which commands are on the always-pause list, and whether an LLM judge is in the loop for ambiguous commands.
7. **Coverage definition for step 4.** "Full coverage" by line/branch %, mutation score, feature-map coverage (every feature + entry point driven), or property coverage? Thresholds per repo or global?
8. **Formal verification scope.** Opt-in per repo on demand, or always offered at setup (pstack offers it once)? TLA+ toolchain (Java) acceptable on all machines?
9. **Property-based/UI fuzz tooling defaults.** fast-check / Hypothesis / proptest per language; Bombadil for web+TUI repos; required in CI or local-only?
10. **Reviewer independence.** Different model family required for review/verification (pstack default), or same model with fresh context acceptable? Which models are available on your plans?
11. **Merge authority.** Agent may merge after independent verifier PASS (Tan end state), or always human sign-off (Netlify)? Per-repo setting? Always stop at merge-ready initially?
12. **CI systems to support.** GitHub Actions only (`gh`-based watcher), or GitLab/others behind a shared verdict interface?
13. **Decision trail persistence.** Local-only TSV, committed for big work, or always committed? Where (`.audit/`)?
14. **Comment policy.** Adopt Tan's ~99% comment ban + `no-comments` pass universally, or per-repo opt-in?
15. **Commit/PR conventions.** Conventional Commits + pstack PR body sections as universal defaults, or follow each repo's existing conventions when present?
16. **Script runtime.** Bun/Node/Deno for bundled CLIs (pstack uses bun with self-bootstrapping lockfile), or POSIX shell + Python? Windows (Git Bash/PowerShell) must work on your machines.
17. **Learning-loop approval.** Should `correct`/`reflect`-style edits auto-apply to H7KZ/Agents, or always go through a PR you approve?
18. **Read the blocked sources?** Medium (Topuz) post and Reddit thread need manual reading; decide if worth it.
