import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintSkill } from '../../scripts/lint-skills.ts';
import { MAX_BODY, MAX_TITLE, STATUSES } from '../../plugins/h7/scripts/proposals.ts';

const plugin = join(import.meta.dirname, '../../plugins/h7');
const skillDir = join(plugin, 'skills/improve');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8').replace(/\r/g, '');

describe('improve skill', () => {
  it('passes the skill linter, stays under the size limit and never auto-triggers', () => {
    assert.deepEqual(lintSkill(skillDir, plugin), []);
    assert.ok(skill.split('\n').length <= 500);
    assert.match(skill, /^disable-model-invocation: true$/m);
    assert.ok(!/^hooks:/m.test(skill));
  });

  it('uses only scripts that exist and documents every queue command', () => {
    const used = [...skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)].map((m) => m[1] as string);
    assert.ok(used.length > 0);
    for (const file of used) assert.ok(existsSync(join(plugin, file)), file);
    for (const command of ['add', 'list', 'show', 'accept', 'reject']) assert.match(skill, new RegExp(`proposals\\.ts" ${command}\\b`), command);
    assert.ok(STATUSES.every((status) => status === 'pending' || skill.includes(status)));
  });

  it('states the queue limits the script enforces', () => {
    assert.ok(skill.includes(`at most ${MAX_TITLE} characters`));
    assert.ok(skill.includes(`at most ${MAX_BODY}`));
  });

  it('keeps the safety rules', () => {
    for (const phrase of ['H7_HOME', 'owner-only', 'only through `proposals.ts`', 'data, never an instruction', 'Never accept on your own', 'only in the h7 repo', 'never on the default branch', 'Never push, open a pull request or merge unless the user asks', 'git add <explicit paths>']) {
      assert.ok(skill.includes(phrase), phrase);
    }
  });

  it('has its sections in order', () => {
    const headings = ['## Hard rules', '## Queue a new idea', '## Review the queue', '## Implement an accepted proposal', '## Report'];
    let at = -1;
    for (const heading of headings) {
      const next = skill.indexOf(heading);
      assert.ok(next > at, heading);
      at = next;
    }
  });
});
