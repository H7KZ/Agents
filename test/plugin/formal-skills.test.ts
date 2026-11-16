import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintSkill } from '../../scripts/lint-skills.ts';
import { KINDS, MODEL_FILE } from '../../plugins/h7/scripts/formal-drift.ts';

const plugin = join(import.meta.dirname, '../../plugins/h7');
const read = (name: string): string => readFileSync(join(plugin, 'skills', name, 'SKILL.md'), 'utf8').replace(/\r/g, '');

for (const name of ['formal-create', 'formal-maintain']) {
  describe(`${name} skill`, () => {
    const skill = read(name);
    it('passes the skill linter, stays under the size limit and never auto-triggers', () => {
      assert.deepEqual(lintSkill(join(plugin, 'skills', name), plugin), []);
      assert.ok(skill.split('\n').length <= 500);
      assert.match(skill, /^disable-model-invocation: true$/m);
      assert.ok(!/^hooks:/m.test(skill));
    });
    it('uses only scripts that exist and the drift CLI commands it has', () => {
      const used = [...skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)].map((m) => m[1] as string);
      assert.ok(used.length > 0);
      for (const file of used) assert.ok(existsSync(join(plugin, file)), file);
      for (const command of [...skill.matchAll(/formal-drift\.ts" (\w+)/g)].map((m) => m[1])) assert.ok(['check', 'stamp'].includes(command as string), String(command));
      assert.match(skill, /formal-drift\.ts" stamp/);
    });
    it('keeps the shared safety rules', () => {
      for (const phrase of ['Never read `.env` files', 'never push', 'Install nothing without asking', 'weaken']) assert.ok(skill.toLowerCase().includes(phrase.toLowerCase()), phrase);
    });
  });
}

describe('formal-create', () => {
  const skill = read('formal-create');
  it('requires true-to-code, able-to-fail and bounds, and documents the manifest the drift script reads', () => {
    for (const phrase of ['True to the code', 'Able to fail', 'Honest scope', 'TLC', 'statechart', MODEL_FILE, '"sources"', '"sync"', '"check"', '"spec"']) assert.ok(skill.includes(phrase), phrase);
    for (const kind of KINDS) assert.ok(skill.includes(`"kind": "${kind}"`) || kind !== 'tla', kind);
  });
  it('has its steps in order', () => {
    const headings = ['## Hard rules', '## 1. Pick the target', '## 2. Toolchain', '## 3. Write the model', '## 4. Run, break, replay', '## 5. Record the model', '## 6. Report'];
    let at = -1;
    for (const heading of headings) {
      const next = skill.indexOf(heading);
      assert.ok(next > at, heading);
      at = next;
    }
  });
});

describe('formal-maintain', () => {
  const skill = read('formal-maintain');
  it('covers every drift status and the classification of changes', () => {
    for (const status of ['in-sync', 'drifted', 'unknown-sync', 'invalid']) assert.ok(skill.includes(`\`${status}\``), status);
    for (const phrase of ['no effect', 'model stale', 'promise changed on purpose', 'promise maybe broken', 'Run the model as it stands first', 'break it again', 'Never edit `sync` by hand']) assert.ok(skill.includes(phrase), phrase);
  });
  it('has its steps in order', () => {
    const headings = ['## Hard rules', '## 1. Detect drift', '## 2. Run as is', '## 3. Classify each change', '## 4. Update from the code', '## 5. Stamp and commit', '## 6. Report'];
    let at = -1;
    for (const heading of headings) {
      const next = skill.indexOf(heading);
      assert.ok(next > at, heading);
      at = next;
    }
  });
});
