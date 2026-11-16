import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseFrontmatter } from '../frontmatter.ts';
import { formatProblem, lintAgent, lintPlugin, lintSkill, main } from '../lint-skills.ts';
import { SLOW, cleanupTmp, runNode, tmpDir, writeTree } from './helpers.ts';

cleanupTmp();

const good = (extra = '') =>
  `---\nname: alpha\ndescription: Does alpha things.\ndisable-model-invocation: true\n---\n# Alpha\n${extra}`;

function plugin(files: Record<string, string>): string {
  const dir = tmpDir();
  writeTree(dir, files);
  return dir;
}

function messages(dir: string): string[] {
  return lintPlugin(dir).map((p) => `${p.line}:${p.message}`);
}

describe('parseFrontmatter', () => {
  it('returns null without opening or closing fence', () => {
    assert.equal(parseFrontmatter('# no'), null);
    assert.equal(parseFrontmatter('\n---\na: b\n---\n'), null);
    assert.equal(parseFrontmatter('---\na: b\n'), null);
  });

  it('parses scalars, quotes, folded values and line numbers', () => {
    const fm = parseFrontmatter('---\nname: x\ndesc: "quoted"\nalt: \'single\'\nfold: >\n  one\n  two\nodd: "half\nbare:\nnot a key\n---\nbody\n');
    assert.ok(fm);
    assert.equal(fm.fields.get('name'), 'x');
    assert.equal(fm.fields.get('desc'), 'quoted');
    assert.equal(fm.fields.get('alt'), 'single');
    assert.equal(fm.fields.get('fold'), 'one two');
    assert.equal(fm.fields.get('odd'), '"half');
    assert.equal(fm.fields.get('bare'), '');
    assert.equal(fm.lines.get('desc'), 3);
  });

  it('handles CRLF and ignores indented lines before any key', () => {
    const fm = parseFrontmatter('---\r\n  stray\r\nname: x\r\n---\r\n');
    assert.equal(fm?.fields.get('name'), 'x');
    assert.equal(fm?.fields.size, 1);
  });
});

describe('lintSkill', () => {
  it('accepts a valid skill with existing references', () => {
    const dir = plugin({
      'skills/alpha/SKILL.md': good('See [ref](references/a.md#top), [web](https://x.y), [anchor](#a), `references/a.md`, `scripts/run.ts`.\nRun `node "${CLAUDE_PLUGIN_ROOT}/scripts/x.ts"` and ${CLAUDE_SKILL_DIR}/references/a.md\n'),
      'skills/alpha/references/a.md': 'x',
      'skills/alpha/scripts/run.ts': 'x',
      'scripts/x.ts': 'x',
      'skills/notes.txt': 'not a skill dir',
    });
    assert.deepEqual(messages(dir), []);
  });

  it('reports a missing SKILL.md', () => {
    assert.deepEqual(messages(plugin({ 'skills/alpha/other.md': 'x' })), ['1:SKILL.md is missing']);
  });

  it('reports frontmatter problems and stops', () => {
    assert.deepEqual(messages(plugin({ 'skills/alpha/SKILL.md': '\n---\nname: alpha\n---\n' })), [
      '1:frontmatter must start on line 1 with --- and be closed with ---',
    ]);
  });

  it('reports wrong name, missing description and missing disable flag with line numbers', () => {
    const dir = plugin({ 'skills/alpha/SKILL.md': '---\nname: beta\ndisable-model-invocation: false\n---\n' });
    assert.deepEqual(messages(dir), [
      '2:name must equal directory name "alpha", got "beta"',
      '1:description is required',
      '3:disable-model-invocation: true is required',
    ]);
  });

  it('reports a missing name', () => {
    const dir = plugin({ 'skills/alpha/SKILL.md': '---\ndescription: d\ndisable-model-invocation: true\n---\n' });
    assert.deepEqual(messages(dir), ['1:name must equal directory name "alpha", got ""']);
  });

  it('enforces the description limit exactly at 1024', () => {
    const make = (n: number) => plugin({ 'skills/alpha/SKILL.md': `---\nname: alpha\ndescription: ${'a'.repeat(n)}\ndisable-model-invocation: true\n---\n` });
    assert.deepEqual(messages(make(1024)), []);
    assert.deepEqual(messages(make(1025)), ['3:description is 1025 chars, limit is 1024']);
  });

  it('enforces the line limit exactly at 500, with or without a trailing newline', () => {
    const header = good().trimEnd().split('\n');
    const file = (lines: number, eol: string, trailing: boolean) => header.concat(Array(lines - header.length).fill('x')).join(eol) + (trailing ? eol : '');
    for (const eol of ['\n', '\r\n']) {
      for (const trailing of [true, false]) {
        assert.deepEqual(messages(plugin({ 'skills/alpha/SKILL.md': file(500, eol, trailing) })), [], `500 ${JSON.stringify(eol)} ${trailing}`);
        assert.deepEqual(messages(plugin({ 'skills/alpha/SKILL.md': file(501, eol, trailing) })), ['501:file has 501 lines, limit is 500']);
      }
    }
  });

  it('reports dangling links and paths with line numbers, ignoring fenced links', () => {
    const body = ['[x](nope.md)', '`references/gone.md`', '```', '[ignored](nowhere.md)', '`scripts/ignored.ts`', 'node ${CLAUDE_PLUGIN_ROOT}/scripts/missing.ts', '```', '${CLAUDE_SKILL_DIR}/lost.md', '[ok](mailto:a@b.c)'].join('\n');
    const dir = plugin({ 'skills/alpha/SKILL.md': good(body) });
    assert.deepEqual(messages(dir), [
      '7:link target does not exist: nope.md',
      '8:referenced path does not exist: references/gone.md',
      '12:plugin path does not exist: scripts/missing.ts',
      '14:skill path does not exist: lost.md',
    ]);
  });

  it('lintSkill can be called directly', () => {
    const dir = plugin({ 'skills/alpha/SKILL.md': good() });
    assert.deepEqual(lintSkill(join(dir, 'skills', 'alpha'), dir), []);
  });
});

describe('lintAgent and lintPlugin', () => {
  it('requires name and description, recursively', () => {
    const dir = plugin({
      'agents/ok.md': '---\nname: ok\ndescription: fine\n---\n',
      'agents/sub/bad.md': '---\nname: bad\n---\n',
      'agents/nofm.md': 'text',
      'agents/readme.txt': 'ignored',
    });
    const problems = lintPlugin(dir).map(formatProblem).map((p) => p.replace(dir, '').replaceAll('\\', '/'));
    assert.deepEqual(problems, ['/agents/nofm.md:1: frontmatter must start on line 1 with --- and be closed with ---', '/agents/sub/bad.md:1: description is required']);
    assert.deepEqual(lintAgent(join(dir, 'agents', 'ok.md')), []);
    const noName = plugin({ 'a.md': '---\ndescription: x\n---\n' });
    assert.deepEqual(lintAgent(join(noName, 'a.md')).map((p) => p.message), ['name is required']);
  });

  it('passes on a plugin with no skills or agents dirs', () => {
    assert.deepEqual(lintPlugin(tmpDir()), []);
  });
});

describe('main and CLI', () => {
  it('returns 0 and prints nothing when clean', () => {
    const lines: string[] = [];
    assert.equal(main([plugin({ 'skills/alpha/SKILL.md': good() })], (l) => lines.push(l)), 0);
    assert.deepEqual(lines, []);
  });

  it('returns 1 and prints file:line messages', () => {
    const lines: string[] = [];
    const dir = plugin({ 'skills/alpha/SKILL.md': '---\nname: z\n---\n' });
    assert.equal(main([dir], (l) => lines.push(l)), 1);
    assert.match(lines[0] as string, /SKILL\.md:2: name must equal/);
  });

  it('defaults to the real plugin directory and passes on the repository', () => {
    assert.equal(main([], () => {}), 0);
  });

  it('works as a subprocess', SLOW, () => {
    const script = join(import.meta.dirname, '..', 'lint-skills.ts');
    const dir = plugin({ 'skills/alpha/SKILL.md': '---\nname: alpha\n---\n' });
    const result = runNode(script, [dir]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /description is required/);
    assert.equal(runNode(script, []).status, 0);
  });
});
