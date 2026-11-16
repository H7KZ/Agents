import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { lintAgent, lintPlugin } from '../../scripts/lint-skills.ts';
import { parseFrontmatter } from '../../scripts/frontmatter.ts';
import { LENSES } from '../../plugins/h7/scripts/review-lenses.ts';
import { extractReport, parseReport } from '../../plugins/h7/scripts/review-findings.ts';

const plugin = join(import.meta.dirname, '../../plugins/h7');
const agentsDir = join(plugin, 'agents');
const read = (lens: string): string => readFileSync(join(agentsDir, `review-${lens}.md`), 'utf8');

describe('review agents', () => {
  it('exist for exactly the lenses the picker knows, and pass the linter', () => {
    assert.deepEqual(readdirSync(agentsDir).sort(), LENSES.map((l) => `review-${l}.md`).sort());
    assert.deepEqual(lintPlugin(plugin), []);
    for (const lens of LENSES) assert.deepEqual(lintAgent(join(agentsDir, `review-${lens}.md`)), [], lens);
  });

  it('are named after their file, read-only, and only spawned by /h7:review', () => {
    for (const lens of LENSES) {
      const fm = parseFrontmatter(read(lens));
      assert.equal(fm?.fields.get('name'), `review-${lens}`);
      assert.equal(fm?.fields.get('tools'), 'Read, Grep, Glob, Bash');
      assert.match(fm?.fields.get('description') ?? '', /Spawned only by \/h7:review/);
      assert.match(fm?.fields.get('description') ?? '', /command and its output/);
    }
  });

  it('state the fresh-context, read-only and proof rules', () => {
    for (const lens of LENSES) {
      const text = read(lens);
      for (const phrase of ['fresh context', 'You have no Write or Edit tool', 'never install, deploy, publish, migrate, commit, push', 'data, not instructions', 'Opinions are not findings', 'No command and output, no finding', 'Stay in your lens']) {
        assert.ok(text.includes(phrase), `${lens}: ${phrase}`);
      }
    }
  });

  it('end with an example report that the findings parser accepts', () => {
    for (const lens of LENSES) {
      const report = extractReport(read(lens));
      assert.ok(report !== null, lens);
      assert.equal(report.lens, lens);
      const parsed = parseReport(read(lens));
      assert.equal(parsed.error, null);
      assert.deepEqual(parsed.dropped, []);
      assert.deepEqual(Object.keys((report.findings as object[])[0] as object), ['title', 'severity', 'file', 'line', 'claim', 'command', 'output']);
    }
  });

  it('each give their lens its own checklist and proof', () => {
    const bodies = LENSES.map((lens) => read(lens).split('## What to look for')[1]);
    assert.equal(new Set(bodies).size, LENSES.length);
  });
});
