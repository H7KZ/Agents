import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintSkill } from '../../scripts/lint-skills.ts';

const plugin = join(import.meta.dirname, '../../plugins/h7');
const skillDir = join(plugin, 'skills/ship');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8').replace(/\r/g, '');

describe('ship skill', () => {
  it('passes the skill linter and stays under the size limit', () => {
    assert.deepEqual(lintSkill(skillDir, plugin), []);
    assert.ok(skill.split('\n').length <= 500);
  });

  it('uses scripts that exist and mentions the helpers', () => {
    for (const m of skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)) assert.ok(existsSync(join(plugin, m[1] as string)), m[1]);
    for (const name of ['ci-watch.ts', 'verify-state.ts', 'verify-gate.ts']) assert.ok(skill.includes(name), name);
  });

  it('registers the Stop gate in its own frontmatter, in exec form', () => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '';
    assert.match(frontmatter, /Stop:\n\s+- hooks:\n\s+- type: command\n\s+command: node\n\s+args: \["\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/verify-gate\.ts"\]/);
    assert.ok(!readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8').includes('verify-gate'));
  });

  it('has every PR body section and the safety rules', () => {
    for (const heading of ['## Why', '## What changed', '## Scope', '## Blast radius', '## Verification', '## Review', '## Decisions']) assert.ok(skill.includes(heading), heading);
    for (const phrase of ['Never push', 'Never merge', 'Auto-merge', 'Conventional Commits', 'pr` or `push', 'READY', 'WAITING', 'BLOCKED', 'git add <explicit paths>', '--body-file', 'one rerun per head commit']) assert.ok(skill.includes(phrase), phrase);
  });

  it('covers every blocker kind the watcher can return', () => {
    for (const kind of ['status-query', 'not-open', 'draft', 'merge-conflicts', 'stale-base', 'review-threads', 'failing-checks', 'merge-gate']) assert.ok(skill.includes(`\`${kind}\``), kind);
  });
});
