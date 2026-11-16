import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintSkill } from '../../scripts/lint-skills.ts';
import { LAYERS } from '../../plugins/h7/scripts/verify-state.ts';

const plugin = join(import.meta.dirname, '../../plugins/h7');
const skillDir = join(plugin, 'skills/verify');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

describe('verify skill', () => {
  it('passes the skill linter and stays under the size limit', () => {
    assert.deepEqual(lintSkill(skillDir, plugin), []);
    assert.ok(skill.split('\n').length <= 500);
  });

  it('uses scripts that exist and mentions every helper', () => {
    for (const m of skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)) assert.ok(existsSync(join(plugin, m[1] as string)), m[1]);
    for (const name of ['verify-scope.ts', 'diff-coverage.ts', 'verify-state.ts', 'verify-gate.ts']) assert.ok(skill.includes(name), name);
  });

  it('names exactly the layers the state file tracks', () => {
    const line = /^Layers: (.+)\./m.exec(skill)?.[1] ?? '';
    assert.deepEqual([...line.matchAll(/`([\w-]+)`/g)].map((m) => m[1]), [...LAYERS]);
  });

  it('states the bar and its guard rails', () => {
    for (const phrase of ['100%', 'at least 80%', 'failing first', 'AskUserQuestion', 'Bombadil', 'stop_hook_active', 'verify-<app>', 'Never push', 'mkdir -p .h7', '--allow-unmeasured', 'warnings[]']) assert.ok(skill.includes(phrase), phrase);
  });

  it('does not register the Stop gate globally or in its own frontmatter', () => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill.replace(/\r/g, ''))?.[1] ?? '';
    assert.ok(!frontmatter.includes('hooks'));
    const hooks = readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8');
    assert.ok(!hooks.includes('verify-gate'));
    assert.match(hooks, /guard\.ts/);
  });

  it('documents a frontmatter registration in exec form', () => {
    assert.match(skill, /command: node\n\s+args: \["\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/verify-gate\.ts"\]/);
  });
});
