import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { detect } from '../../plugins/h7/scripts/detect.ts';
import { lintSkill } from '../../scripts/lint-skills.ts';
import { cleanupTmp, tmpDir } from '../../scripts/test/helpers.ts';

cleanupTmp();

const plugin = join(import.meta.dirname, '../../plugins/h7');
const skillDir = join(plugin, 'skills/setup');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const ref = (name: string): string => readFileSync(join(skillDir, 'references', name), 'utf8');
const h2 = (text: string): string[] => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1] as string);

describe('setup skill', () => {
  it('passes the skill linter', () => {
    assert.deepEqual(lintSkill(skillDir, plugin), []);
  });

  it('links every template and every template is linked', () => {
    const files = readdirSync(join(skillDir, 'references')).sort();
    const linked = [...skill.matchAll(/\]\(references\/([^)]+)\)/g)].map((m) => m[1] as string);
    assert.deepEqual([...new Set(linked)].sort(), files);
  });

  it('uses scripts that exist', () => {
    for (const m of skill.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[\w.-]+)/g)) {
      assert.ok(readFileSync(join(plugin, m[1] as string), 'utf8').length > 0, m[1]);
    }
    assert.match(skill, /setup-files\.ts/);
    assert.match(skill, /detect\.ts/);
  });

  it('feature template has exactly the four H2s', () => {
    assert.deepEqual(h2(ref('feature.template.md')), ['Sub-features', 'How to get to it (user POV)', 'Driving it', 'Gotchas']);
  });

  it('verify skill template has the pstack sections in order and is user-only', () => {
    const t = ref('verify-skill.template.md');
    assert.deepEqual(h2(t), ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup', 'Helpers']);
    assert.match(t, /^disable-model-invocation: true$/m);
    assert.match(t, /\.h7\/evidence/);
  });

  it('verification template carries every required section and status marker', () => {
    const t = ref('verification.template.md');
    assert.deepEqual(h2(t), ['Commands', 'Thresholds', 'App surfaces', 'CI', 'Ship', 'Layers not applicable', 'Gaps']);
    for (const word of ['UNVERIFIED', 'GAP', 'Diff coverage', 'Mutation (changed files)', 'Full local check', 'at least 80%', '100%', 'Auto-merge', 'Ship mode', 'gh run rerun']) {
      assert.ok(t.includes(word), word);
    }
  });

  it('agents block template stays small and has the enforcer table', () => {
    const t = ref('agents-block.template.md');
    assert.ok(t.split('\n').length < 40);
    assert.match(t, /\| Rule \| Enforcer \|/);
    assert.match(t, /docs\/agents\/verification\.md/);
  });

  it('detect output has every field the skill reads', () => {
    const d = detect(tmpDir(), () => ({ status: 128, stdout: '' }));
    const read = skill.match(/Fields: (.+)/) as RegExpMatchArray;
    for (const field of ['languages', 'packageManagers', 'monorepo', 'scripts', 'tools', 'layers', 'surfaces', 'ci', 'docs', 'git', 'gaps', 'warnings']) {
      assert.ok(field in d, field);
      assert.ok((read[1] as string).includes(field), field);
    }
  });
});
