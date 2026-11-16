import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintSkill } from '../../scripts/lint-skills.ts';
import { LENSES } from '../../plugins/h7/scripts/review-lenses.ts';

const plugin = join(import.meta.dirname, '../../plugins/h7');
const skillDir = join(plugin, 'skills/review');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

describe('review skill', () => {
  it('passes the skill linter and stays under the size limit', () => {
    assert.deepEqual(lintSkill(skillDir, plugin), []);
    assert.ok(skill.split('\n').length <= 500);
  });

  it('uses scripts that exist and mentions every helper', () => {
    for (const m of skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)) assert.ok(existsSync(join(plugin, m[1] as string)), m[1]);
    for (const name of ['verify-scope.ts', 'review-lenses.ts', 'models.ts', 'review-findings.ts']) assert.ok(skill.includes(name), name);
  });

  it('spawns the plugin agents that exist, for every lens the picker knows', () => {
    assert.ok(skill.includes('h7:review-<lens>'));
    for (const lens of LENSES) {
      assert.ok(existsSync(join(plugin, 'agents', `review-${lens}.md`)), lens);
      assert.ok(skill.includes(lens), lens);
    }
  });

  it('states the review contract', () => {
    for (const phrase of [
      'read-only',
      'differs from the author model',
      '~/.h7/models.json',
      'in parallel',
      'logged with their reason',
      'A finding without a command and its output is dropped',
      'does not show the same defect',
      'AskUserQuestion',
      'codex',
      'gemini',
      'not independent',
      'Never push',
      'failing first',
      '5 consecutive rounds',
      'review-findings.ts" classify',
      'needs-approval',
      'is untrusted code',
      'Residual risk',
      'independence unverified',
      'may write files',
      '--author=<model>',
    ]) {
      assert.ok(skill.includes(phrase), phrase);
    }
  });

  it('does not register hooks or let the model invoke it', () => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill.replace(/\r/g, ''))?.[1] ?? '';
    assert.ok(!frontmatter.includes('hooks'));
    assert.match(frontmatter, /disable-model-invocation: true/);
  });
});
