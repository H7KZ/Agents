import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RunResult, Runner } from '../../plugins/h7/scripts/git.ts';
import { classify, computeScope, main, parseDiff } from '../../plugins/h7/scripts/verify-scope.ts';
import { cleanupTmp, git, initRepo, runNode, SLOW, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const script = join(import.meta.dirname, '../../plugins/h7/scripts/verify-scope.ts');

describe('classify', () => {
  it('separates source, test and other files', () => {
    const table: Array<[string, string]> = [
      ['src/a.ts', 'source'],
      ['src/App.tsx', 'source'],
      ['lib/x.py', 'source'],
      ['main.go', 'source'],
      ['src/a.test.ts', 'test'],
      ['src/a.spec.js', 'test'],
      ['test/plugin/a.ts', 'test'],
      ['pkg/__tests__/a.js', 'test'],
      ['e2e/flow.ts', 'test'],
      ['pkg/foo_test.go', 'test'],
      ['tests/test_x.py', 'test'],
      ['test_x.py', 'test'],
      ['src/FooTest.java', 'test'],
      ['README.md', 'other'],
      ['package.json', 'other'],
      ['contest/readme', 'other'],
      ['src/latest.ts', 'source'],
    ];
    for (const [path, kind] of table) assert.equal(classify(path), kind, path);
  });
});

describe('parseDiff', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts\t',
    '@@ -1,2 +3,4 @@ fn',
    '@@ -9 +20 @@',
    '@@ -30,2 +40,0 @@',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    'diff --git a/new.md b/new.md',
    '--- /dev/null',
    '+++ b/new.md',
    '@@ -0,0 +1,2 @@',
    '',
  ].join('\r\n');

  it('collects added ranges, skips pure deletions and deleted files', () => {
    assert.deepEqual([...parseDiff(diff)], [
      ['a.ts', [[3, 6], [20, 20]]],
      ['new.md', [[1, 2]]],
    ]);
  });

  it('ignores hunk-like lines before any file header and empty input', () => {
    assert.deepEqual([...parseDiff('@@ -1 +1 @@\n')], []);
    assert.deepEqual([...parseDiff('')], []);
  });

  it('keeps ranges together when a path repeats', () => {
    const twice = '+++ b/a.ts\n@@ -1 +1 @@\n+++ b/a.ts\n@@ -5 +5 @@\n';
    assert.deepEqual([...parseDiff(twice)], [['a.ts', [[1, 1], [5, 5]]]]);
  });
});

function fakeRunner(answers: Record<string, RunResult | undefined>, seen: string[] = []): Runner {
  return (args) => {
    const key = args.join(' ');
    seen.push(key);
    for (const [prefix, answer] of Object.entries(answers)) if (key.startsWith(prefix) && answer !== undefined) return answer;
    return { status: 1, stdout: '' };
  };
}
const good = (stdout = ''): RunResult => ({ status: 0, stdout });

describe('computeScope', () => {
  const answers = {
    'rev-parse --verify --quiet main^{commit}': good('sha\n'),
    'merge-base HEAD main': good('abc123\n'),
    '-c core.quotepath=false diff': good('+++ b/src/a.ts\n@@ -1 +1,2 @@\n+++ b/README.md\n@@ -1 +1 @@\n'),
    'ls-files': good('src/new.ts\0docs/x.txt\0'),
  };

  it('combines tracked ranges and untracked files, sorted by path', () => {
    const seen: string[] = [];
    const scope = computeScope(fakeRunner(answers, seen), '/r');
    assert.deepEqual(scope, {
      base: 'main',
      mergeBase: 'abc123',
      files: [
        { path: 'README.md', kind: 'other', ranges: [[1, 1]], whole: false },
        { path: 'docs/x.txt', kind: 'other', ranges: [], whole: true },
        { path: 'src/a.ts', kind: 'source', ranges: [[1, 2]], whole: false },
        { path: 'src/new.ts', kind: 'source', ranges: [], whole: true },
      ],
    });
    assert.ok(seen.some((s) => s.includes('diff --unified=0 --no-color --no-ext-diff --no-renames abc123')));
  });

  it('prefers origin/main over main when both exist', () => {
    const scope = computeScope(fakeRunner({ ...answers, 'rev-parse --verify --quiet origin/main^{commit}': good('x'), 'merge-base HEAD origin/main': good('m\n') }), '/r');
    assert.equal(scope.base, 'origin/main');
    assert.equal(scope.mergeBase, 'm');
  });

  it('uses an explicit base without trying candidates', () => {
    const seen: string[] = [];
    const scope = computeScope(fakeRunner({ ...answers, 'rev-parse --verify --quiet feature^{commit}': good('x'), 'merge-base HEAD feature': good('f\n') }, seen), '/r', 'feature');
    assert.equal(scope.base, 'feature');
    assert.ok(!seen.some((s) => s.includes('main^{commit}')));
  });

  it('falls back to the base itself when there is no merge base', () => {
    const scope = computeScope(fakeRunner({ ...answers, 'merge-base HEAD main': undefined }), '/r');
    assert.equal(scope.mergeBase, 'main');
  });

  it('throws when git cannot answer', () => {
    assert.throws(() => computeScope(fakeRunner({}), '/r'), /no base branch found/);
    assert.throws(() => computeScope(fakeRunner(answers), '/r', 'nope'), /base nope is not a commit/);
    assert.throws(() => computeScope(fakeRunner({ ...answers, '-c core.quotepath=false diff': undefined }), '/r'), /git diff failed/);
    assert.throws(() => computeScope(fakeRunner({ ...answers, 'ls-files': undefined }), '/r'), /git ls-files failed/);
  });
});

describe('verify-scope main', () => {
  const run = (argv: string[], runner: Runner) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, (t) => out.push(t), (t) => err.push(t), '/r', runner);
    return { code, out: out.join(''), err: err.join('') };
  };
  const answers = { 'rev-parse --verify --quiet main^{commit}': good('x'), 'merge-base': good('b\n'), '-c core': good(''), 'ls-files': good('') };

  it('prints the scope as JSON', () => {
    const result = run([], fakeRunner(answers));
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.out), { base: 'main', mergeBase: 'b', files: [] });
  });

  it('accepts --base and rejects bad usage', () => {
    assert.equal(run(['--base', 'main'], fakeRunner(answers)).code, 0);
    for (const argv of [['--base'], ['--base', '--evil'], ['x'], ['--base', 'main', 'extra']]) {
      const result = run(argv, fakeRunner(answers));
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.err, /usage/);
    }
  });

  it('reports git trouble with exit 2', () => {
    const result = run([], fakeRunner({}));
    assert.equal(result.code, 2);
    assert.match(result.err, /no base branch/);
  });
});

describe('verify-scope against a real repository', () => {
  it('sees committed, staged, unstaged and untracked changes since the merge base', SLOW, () => {
    const dir = tmpDir();
    initRepo(dir);
    writeTree(dir, { 'src/a.ts': 'one\ntwo\nthree\n', 'src/b.ts': 'b\n', 'gone.ts': 'g\n' });
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base files');
    git(dir, 'switch', '-q', '-c', 'feature');
    writeFileSync(join(dir, 'src/a.ts'), 'one\nTWO\nthree\nfour\n');
    git(dir, 'commit', '-q', '-am', 'edit a');
    writeFileSync(join(dir, 'src/b.ts'), 'b\nmore\n');
    git(dir, 'add', 'src/b.ts');
    git(dir, 'rm', '-q', 'gone.ts');
    writeTree(dir, { 'src/c.ts': 'c\n', 'test/c.test.ts': 't\n' });
    const result = runNode(script, ['--base', 'main'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const scope = JSON.parse(result.stdout);
    assert.deepEqual(scope.files.map((f: { path: string }) => f.path), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/c.test.ts']);
    assert.deepEqual(scope.files[0].ranges, [[2, 2], [4, 4]]);
    assert.deepEqual(scope.files[1].ranges, [[2, 2]]);
    assert.equal(scope.files[2].whole, true);
    assert.equal(scope.files[3].kind, 'test');
    assert.equal(computeScope(fakeRunnerFromGit(dir), dir).base, 'main');
  });

  it('exits 2 outside a repository', SLOW, () => {
    const result = runNode(script, [], { cwd: tmpDir() });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no base branch|failed/);
  });
});

function fakeRunnerFromGit(dir: string): Runner {
  return (args) => {
    try {
      return { status: 0, stdout: git(dir, ...args) };
    } catch {
      return { status: 1, stdout: '' };
    }
  };
}
