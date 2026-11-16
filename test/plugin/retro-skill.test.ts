import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintSkill } from '../../scripts/lint-skills.ts';
import { KINDS, MAX_CELL } from '../../plugins/h7/scripts/retro-rows.ts';

const plugin = join(import.meta.dirname, '../../plugins/h7');
const skillDir = join(plugin, 'skills/retro');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8').replace(/\r/g, '');

describe('retro skill', () => {
  it('passes the skill linter, stays under the size limit and never auto-triggers', () => {
    assert.deepEqual(lintSkill(skillDir, plugin), []);
    assert.ok(skill.split('\n').length <= 500);
    assert.match(skill, /^disable-model-invocation: true$/m);
    assert.ok(!/^hooks:/m.test(skill));
  });

  it('uses only scripts that exist, with every helper command documented', () => {
    const used = [...skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)].map((m) => m[1] as string);
    assert.ok(used.length > 0);
    for (const file of used) assert.ok(existsSync(join(plugin, file)), file);
    for (const command of ['signals', 'propose', 'reject', 'apply']) assert.match(skill, new RegExp(`retro-rows\\.ts" ${command}\\b`), command);
    assert.match(skill, /apply r1 --write/);
  });

  it('keeps the approval and evidence rules', () => {
    for (const phrase of ['No evidence, no row', 'row by row', 'Never approve in bulk', 'never "apply all"', 'Retro only adds', 'Never push', 'must be able to fail', '`.env`']) {
      assert.ok(skill.toLowerCase().includes(phrase.toLowerCase()), phrase);
    }
  });

  it('names every row kind in the order of the fix hierarchy and the cell limit', () => {
    const at = KINDS.map((kind) => skill.indexOf(`\`${kind}\``));
    assert.ok(at.every((i) => i > -1), String(at));
    assert.match(skill, new RegExp(`${MAX_CELL} characters`));
    assert.ok(skill.indexOf('architecture (make') < skill.indexOf('prose (a rule'));
  });

  it('has its steps in order', () => {
    const headings = ['## Hard rules', '## 1. Collect', '## 2. Draft rows', '## 3. Ask, row by row', '## 4. Apply the approved rows', '## 5. Report'];
    let at = -1;
    for (const heading of headings) {
      const next = skill.indexOf(heading);
      assert.ok(next > at, heading);
      at = next;
    }
  });
});
