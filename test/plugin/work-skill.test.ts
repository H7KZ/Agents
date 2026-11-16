import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintSkill } from '../../scripts/lint-skills.ts';
import { PHASES, STALL_LIMIT } from '../../plugins/h7/scripts/run-journal-core.ts';

const plugin = join(import.meta.dirname, '../../plugins/h7');
const skillDir = join(plugin, 'skills/work');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8').replace(/\r/g, '');

describe('work skill', () => {
  it('passes the skill linter and stays under the size limit', () => {
    assert.deepEqual(lintSkill(skillDir, plugin), []);
    assert.ok(skill.split('\n').length <= 500);
  });

  it('uses scripts that exist', () => {
    const used = [...skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)].map((m) => m[1] as string);
    for (const file of used) assert.ok(existsSync(join(plugin, file)), file);
    for (const name of ['run-journal.ts', 'verify-state.ts', 'verify-gate.ts']) assert.ok(skill.includes(name), name);
  });

  it('registers the Stop gate in its own frontmatter, in exec form, and not globally', () => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '';
    assert.match(frontmatter, /Stop:\n\s+- hooks:\n\s+- type: command\n\s+command: node\n\s+args: \["\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/verify-gate\.ts"\]/);
    assert.ok(!readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8').includes('verify-gate'));
  });

  it('loads phase skills by reading their files, never through the Skill tool', () => {
    for (const phase of ['verify', 'review', 'ship']) {
      assert.ok(skill.includes(`\${CLAUDE_PLUGIN_ROOT}/skills/${phase}/SKILL.md`), phase);
      assert.ok(existsSync(join(plugin, 'skills', phase, 'SKILL.md')), phase);
    }
    assert.match(skill, /Never try to invoke an h7 skill through the Skill tool/);
  });

  it('has every phase heading in order and the loop rules', () => {
    const headings = ['## 0. Start or resume', '## Journal', '## 1. Research', '## 2. Grill', '## 3. Implement', '## 4. Verify, then review', '## 5. Loop', '## 6. Ship', '## 7. Report'];
    let at = -1;
    for (const heading of headings) {
      const next = skill.indexOf(heading);
      assert.ok(next > at, heading);
      at = next;
    }
    for (const phrase of ['never relaxed', 'Failing first', `${STALL_LIMIT} consecutive non-improving rounds`, 'progress', 'Never push, merge or open a pull request', 'git-excluded', 'git add <explicit paths>']) assert.ok(skill.includes(phrase), phrase);
  });

  it('documents every journal phase', () => {
    for (const phase of PHASES) assert.ok(skill.includes(`\`${phase}\``), phase);
  });

  it('keeps the run id, explains the brake as the script computes it, and the PowerShell form', () => {
    for (const phrase of ['--run <id>', 'CURRENT', 'best score', 'never raise it above 5', 'warnings[]', 'observed', 'both counts are required', 'info/exclude', '${CLAUDE_PLUGIN_ROOT}/scripts/run-journal.ts" append --run <id> <phase> -']) assert.ok(skill.includes(phrase), phrase);
  });
});
