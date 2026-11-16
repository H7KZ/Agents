import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';
import { ARCH_FILES, ARCH_LINES, LENSES, PERF_LINES, WHOLE_FILE_LINES, main, parseScope, planLenses, realRead, type ChangedFile, type Lens } from '../../plugins/h7/scripts/review-lenses.ts';
import { classify } from '../../plugins/h7/scripts/verify-scope.ts';

cleanupTmp();

const script = join(import.meta.dirname, '../../plugins/h7/scripts/review-lenses.ts');

const file = (path: string, lines = 5, over: Partial<ChangedFile> = {}): ChangedFile => ({ path, kind: classify(path), ranges: [[1, lines]], whole: false, ...over });
const selected = (files: ChangedFile[], all = false): Lens[] => planLenses(files, all).selected.map((c) => c.lens);
const skipped = (files: ChangedFile[]): Lens[] => planLenses(files).skipped.map((c) => c.lens);

describe('planLenses', () => {
  it('skips everything, with a reason, for an empty change', () => {
    const plan = planLenses([]);
    assert.deepEqual(plan.selected, []);
    assert.deepEqual(plan.skipped.map((c) => c.lens), [...LENSES]);
    assert.ok(plan.skipped.every((c) => c.reason === 'no changed files'));
  });

  it('keeps only spec for a prose and configuration change', () => {
    const files = [file('README.md'), file('docs/design.md'), file('tsconfig.json')];
    assert.deepEqual(selected(files), ['spec']);
    assert.deepEqual(skipped(files), ['standards', 'adversarial', 'security', 'performance', 'test-quality', 'architecture']);
  });

  it('picks the core lenses for a small source change with its test', () => {
    const files = [file('src/util.ts'), file('test/util.test.ts')];
    assert.deepEqual(selected(files), ['spec', 'standards', 'adversarial', 'test-quality']);
    assert.deepEqual(skipped(files), ['security', 'performance', 'architecture']);
  });

  it('selects test-quality and standards for a tests-only change but not adversarial', () => {
    assert.deepEqual(selected([file('test/a.test.ts')]), ['spec', 'standards', 'test-quality']);
  });

  it('selects security for sensitive paths and dependency or CI manifests, in any file kind', () => {
    for (const path of ['src/auth/login.ts', 'package.json', '.github/workflows/ci.yml', 'Dockerfile', 'config/.env.example', 'scripts/run-shell.sh', 'plugins/h7/hooks/hooks.json', 'src/Server.ts']) {
      assert.ok(selected([file(path)]).includes('security'), path);
    }
    assert.ok(!selected([file('src/format.ts')]).includes('security'));
  });

  it('selects performance by size or hot-path file names, only for source', () => {
    assert.ok(!selected([file('src/a.ts', PERF_LINES - 1)]).includes('performance'));
    assert.ok(selected([file('src/a.ts', PERF_LINES)]).includes('performance'));
    assert.ok(selected([file('src/query-builder.ts')]).includes('performance'));
    assert.ok(!selected([file('docs/cache-notes.md')]).includes('performance'));
    assert.ok(!selected([file('test/cache.test.ts', 500)]).includes('performance'));
  });

  it('selects architecture for many files, several directories or large changes', () => {
    const many = Array.from({ length: ARCH_FILES }, (_, i) => file(`src/f${i}.ts`));
    assert.ok(selected(many).includes('architecture'));
    assert.ok(!selected(many.slice(1)).includes('architecture'));
    assert.ok(selected([file('src/a/x.ts'), file('src/b/y.ts')]).includes('architecture'));
    assert.ok(selected([file('src/a.ts', ARCH_LINES)]).includes('architecture'));
    assert.ok(!selected([file('src/a.ts', ARCH_LINES - 1)]).includes('architecture'));
  });

  it('counts an untracked file as WHOLE_FILE_LINES and sums several ranges', () => {
    assert.equal(planLenses([file('src/n.ts', 1, { ranges: [], whole: true })]).stats.changedLines, WHOLE_FILE_LINES);
    const two = file('src/a.ts', 1, { ranges: [[1, 10], [20, 29]] });
    assert.equal(planLenses([two]).stats.changedLines, 20);
  });

  it('reports stats by kind', () => {
    const plan = planLenses([file('src/a.ts', 3), file('test/a.test.ts', 4), file('README.md', 2)]);
    assert.deepEqual(plan.stats, { files: 3, source: 1, test: 1, other: 1, changedLines: 9 });
  });

  it('--all selects every lens even for an empty change', () => {
    assert.deepEqual(selected([], true), [...LENSES]);
    assert.ok(planLenses([file('README.md')], true).selected.every((c) => c.reason === 'forced by --all'));
    assert.deepEqual(planLenses([file('README.md')], true).skipped, []);
  });

  it('property: every lens appears exactly once, selected or skipped, always with a reason', () => {
    const item = fc.record({ path: fc.constantFrom('src/a.ts', 'src/b/c.ts', 'test/a.test.ts', 'README.md', 'package.json', 'src/auth.ts'), lines: fc.integer({ min: 1, max: 400 }) });
    fc.assert(
      fc.property(fc.array(item, { maxLength: 6 }), fc.boolean(), (items, all) => {
        const plan = planLenses(items.map((i) => file(i.path, i.lines)), all);
        const lenses = [...plan.selected, ...plan.skipped].map((c) => c.lens).sort();
        assert.deepEqual(lenses, [...LENSES].sort());
        assert.ok([...plan.selected, ...plan.skipped].every((c) => c.reason !== ''));
      }),
    );
  });
});

describe('parseScope', () => {
  it('reads files from a verify-scope document, tolerating missing ranges', () => {
    const body = JSON.stringify({ base: 'main', files: [{ path: 'a.ts', kind: 'source', ranges: [[1, 2], 'x', [1]], whole: false }, { path: 'b.md', kind: 'other', whole: true }] });
    assert.deepEqual(parseScope(body), [
      { path: 'a.ts', kind: 'source', ranges: [[1, 2]], whole: false },
      { path: 'b.md', kind: 'other', ranges: [], whole: true },
    ]);
  });

  it('is null for anything else, never throwing', () => {
    for (const body of ['', '{', 'null', '[]', '{"files":3}', '{"files":[null]}', '{"files":[{"path":1,"kind":"source"}]}', '{"files":[{"path":"a","kind":3}]}', '{"files":[{"path":"a","kind":"weird"}]}']) {
      assert.equal(parseScope(body), null, body);
    }
    fc.assert(fc.property(fc.string(), (body) => void parseScope(body)));
  });
});

describe('main', () => {
  const scope = JSON.stringify({ files: [{ path: 'src/a.ts', kind: 'source', ranges: [[1, 3]], whole: false }] });
  const run = (argv: string[], body: string | null = scope) => {
    const out: string[] = [];
    const err: string[] = [];
    return { code: main(argv, (t) => out.push(t), (t) => err.push(t), () => body), out, err };
  };

  it('prints the plan as JSON, honoring --all in any position', () => {
    const plan = JSON.parse(run(['scope.json']).out[0] as string) as { selected: unknown[]; skipped: unknown[] };
    assert.equal(plan.selected.length + plan.skipped.length, LENSES.length);
    assert.equal((JSON.parse(run(['--all', 'scope.json']).out[0] as string) as { skipped: unknown[] }).skipped.length, 0);
    assert.equal((JSON.parse(run(['scope.json', '--all']).out[0] as string) as { skipped: unknown[] }).skipped.length, 0);
  });

  it('fails on usage errors, unreadable scope and non-scope files', () => {
    for (const argv of [[], ['--all'], ['a', 'b']]) {
      const r = run(argv);
      assert.equal(r.code, 2);
      assert.match(r.err[0] as string, /usage: review-lenses\.ts/);
    }
    for (const body of [null, '{}']) {
      const r = run(['scope.json'], body);
      assert.equal(r.code, 2);
      assert.match(r.err[0] as string, /not a verify-scope\.ts result/);
    }
  });
});

describe('review-lenses.ts as a script', () => {
  it('plans from a scope file on disk', () => {
    const dir = tmpDir();
    writeTree(dir, { 'scope.json': JSON.stringify({ files: [{ path: 'README.md', kind: 'other', ranges: [[1, 1]], whole: false }] }) });
    const ok = spawnSync(process.execPath, [script, join(dir, 'scope.json')], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal((JSON.parse(ok.stdout) as { selected: unknown[] }).selected.length, 1);
    const bad = spawnSync(process.execPath, [script, join(dir, 'missing.json')], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.equal(realRead(join(dir, 'missing.json')), null);
    assert.equal(realRead(join(dir, 'scope.json'))?.startsWith('{'), true);
  });
});
