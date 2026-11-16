import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, it } from 'node:test';
import type { RunResult, Runner } from '../../plugins/h7/scripts/git.ts';
import fc from 'fast-check';
import { classify, computeScope, main, parseDiff, unquote } from '../../plugins/h7/scripts/verify-scope.ts';
import { cleanupTmp, git, initRepo, runNode, runs, SLOW, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const BS = String.fromCharCode(92);
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
    '-o1',
    '-o2',
    '+n1',
    '+n2',
    '+n3',
    '+n4',
    '\ No newline at end of file',
    '@@ -9 +20 @@',
    '-old',
    '+new',
    '@@ -30,2 +40,0 @@',
    '-gone1',
    '-gone2',
    'diff --git a/gone.ts b/gone.ts',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-a',
    '-b',
    '-c',
    'diff --git a/new.md b/new.md',
    '--- /dev/null',
    '+++ b/new.md',
    '@@ -0,0 +1,2 @@',
    '+l1',
    '+l2',
    '',
  ].join('\n');

  it('collects added ranges, skips pure deletions and deleted files', () => {
    assert.deepEqual([...parseDiff(diff)], [
      ['a.ts', [[3, 6], [20, 20]]],
      ['new.md', [[1, 2]]],
    ]);
  });

  it('ignores hunk-like lines before any file header and empty input', () => {
    assert.deepEqual([...parseDiff('@@ -1 +1 @@\n-a\n+b\n')], []);
    assert.deepEqual([...parseDiff('')], []);
  });

  it('keeps ranges together when a path repeats', () => {
    const twice = '+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n+++ b/a.ts\n@@ -5 +5 @@\n-c\n+d\n';
    assert.deepEqual([...parseDiff(twice)], [['a.ts', [[1, 1], [5, 5]]]]);
  });

  it('does not take added or removed content for file headers or hunks', () => {
    const tricky = ['+++ b/real.ts', '@@ -1,2 +1,3 @@', '+++ b/evil.ts', '-- a/evil.ts', '+@@ -1 +9 @@', ' context', '+++ b/next.ts', '@@ -1 +1 @@', '-x', '+y', ''].join('\n');
    assert.deepEqual([...parseDiff(tricky)], [['real.ts', [[1, 3]]], ['next.ts', [[1, 1]]]]);
  });

  it('reads quoted paths', () => {
    const quoted = `+++ "b/sp${BS}303${BS}251${BS}"q${BS}${BS}.ts"\n@@ -0,0 +1 @@\n+x\n`;
    assert.deepEqual([...parseDiff(quoted)].map(([path]) => path), [`spé"q${BS}.ts`]);
  });

  it('property: arbitrary added content never creates files or ranges', () => {
    const content = fc.array(fc.oneof(fc.constant('++ b/evil.ts'), fc.constant('@@ -1 +1 @@'), fc.constant('-- a/x'), fc.string()), { minLength: 1, maxLength: 12 });
    fc.assert(
      fc.property(content, fc.integer({ min: 1, max: 50 }), (added, start) => {
        const body = added.map((line) => `+${line.replace(/\n/g, ' ')}`);
        const text = `+++ b/real.ts\n@@ -0,0 +${start},${added.length} @@\n${body.join('\n')}\n`;
        assert.deepEqual([...parseDiff(text)], [['real.ts', [[start, start + added.length - 1]]]]);
      }),
      { numRuns: runs(200) },
    );
  });
});

describe('unquote', () => {
  it('handles plain, tab-terminated and every escape form', () => {
    assert.equal(unquote('a b.ts'), 'a b.ts');
    assert.equal(unquote('b/a b.ts\tx'), 'b/a b.ts');
    const q = (...escapes: string[]): string => `"${escapes.map((e) => BS + e).join('')}"`;
    assert.equal(unquote(q('t', 'n', 'a', 'b', 'v', 'f', 'r', '"', BS)), '\t\n\x07\x08\x0b\x0c\r"' + BS);
    assert.equal(unquote(`${q('303', '251')}`.slice(0, -1) + '-é"'), 'é-é');
    assert.equal(unquote(q('q')), 'q');
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
    'rev-parse --show-toplevel': good('/r\n'),
    'rev-parse --verify --quiet main^{commit}': good('sha\n'),
    'merge-base HEAD main': good('abc123\n'),
    '-c core.quotepath=false diff': good('+++ b/src/a.ts\n@@ -1 +1,2 @@\n+x\n+y\n-z\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n'),
    'ls-files': good('src/new.ts\0docs/x.txt\0'),
  };

  it('combines tracked ranges and untracked files, sorted by path', () => {
    const seen: string[] = [];
    const scope = computeScope(fakeRunner(answers, seen), '/r');
    assert.deepEqual(scope, {
      base: 'main',
      mergeBase: 'abc123',
      warnings: [],
      files: [
        { path: 'README.md', kind: 'other', ranges: [[1, 1]], whole: false },
        { path: 'docs/x.txt', kind: 'other', ranges: [], whole: true },
        { path: 'src/a.ts', kind: 'source', ranges: [[1, 2]], whole: false },
        { path: 'src/new.ts', kind: 'source', ranges: [], whole: true },
      ],
    });
    assert.ok(seen.some((s) => s.includes('diff --unified=0 --no-color --no-ext-diff --no-textconv --no-renames abc123')));
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
    assert.throws(() => computeScope(fakeRunner({ 'rev-parse --show-toplevel': good('/r') }), '/r'), /no base branch found/);
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
  const answers = { 'rev-parse --show-toplevel': good('/r'), 'rev-parse --verify --quiet main^{commit}': good('x'), 'merge-base': good('b\n'), '-c core': good(''), 'ls-files': good('') };

  it('prints the scope as JSON', () => {
    const result = run([], fakeRunner(answers));
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.out), { base: 'main', mergeBase: 'b', files: [], warnings: [] });
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
    const result = run([], fakeRunner({ 'rev-parse --show-toplevel': good('/r') }));
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
    assert.match(result.stderr, /not inside a git repository/);
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

describe('verify-scope hardening', () => {
  it('never runs a textconv driver configured in the repository', SLOW, () => {
    const dir = tmpDir();
    initRepo(dir);
    const marker = join(dir, 'textconv-ran');
    const driver = join(dir, 'driver.js');
    writeTree(dir, {
      'driver.js': `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdout.write('x');\n`,
      '.gitattributes': '*.ts diff=evil\n',
      'a.ts': 'one\n',
    });
    git(dir, 'config', 'diff.evil.textconv', `node "${driver.split(sep).join('/')}"`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'files');
    writeFileSync(join(dir, 'a.ts'), 'two\n');
    git(dir, 'diff', '--no-ext-diff');
    assert.ok(existsSync(marker), 'control: plain git diff runs the driver');
    rmSync(marker);
    const result = runNode(script, ['--base', 'HEAD'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).files.map((f: { path: string }) => f.path), ['a.ts']);
    assert.equal(existsSync(marker), false);
  });
});

describe('verify-scope robustness', () => {
  const toplevel = { 'rev-parse --show-toplevel': good('/r\n') };

  it('warns instead of silently falling back when there is no merge base', () => {
    const answers = { ...toplevel, 'rev-parse --verify --quiet main^{commit}': good('x'), '-c core': good(''), 'ls-files': good('') };
    const scope = computeScope(fakeRunner(answers), '/r');
    assert.equal(scope.mergeBase, 'main');
    assert.deepEqual(scope.warnings, ['no merge base between HEAD and main; diffing against main itself']);
  });

  it('rejects a base that looks like an option and a start directory outside a repository', () => {
    assert.throws(() => computeScope(fakeRunner(toplevel), '/r', '--output=x'), /looks like an option/);
    assert.throws(() => computeScope(fakeRunner({}), '/r'), /not inside a git repository/);
    assert.throws(() => computeScope(fakeRunner({ 'rev-parse --show-toplevel': good('\n') }), '/r'), /not inside a git repository/);
  });

  it('runs every later git command from the repository root', () => {
    const cwds: string[] = [];
    const run: Runner = (args, cwd) => {
      cwds.push(`${args[0]}@${cwd}`);
      return args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? good('/top\n') : good('x');
    };
    computeScope(run, '/top/sub', 'main');
    assert.equal(cwds[0], 'rev-parse@/top/sub');
    assert.ok(cwds.slice(1).every((c) => c.endsWith('@/top')), cwds.join());
  });

  it('from a subdirectory sees changes and untracked files everywhere, with root-relative paths', SLOW, () => {
    const dir = tmpDir();
    initRepo(dir);
    writeTree(dir, { 'sub/in.ts': 'a\n', 'top.ts': 'a\n' });
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'files');
    writeTree(dir, { 'sub/in.ts': 'a\nb\n', 'top.ts': 'changed\n', 'sub/new.ts': 'n\n', 'other/new.ts': 'n\n', 'sub/uté.ts': 'q\n' });
    git(dir, 'add', 'sub/in.ts');
    const result = runNode(script, ['--base', 'main'], { cwd: join(dir, 'sub') });
    assert.equal(result.status, 0, result.stderr);
    const files = JSON.parse(result.stdout).files as Array<{ path: string; ranges: number[][]; whole: boolean }>;
    assert.deepEqual(files.map((f) => f.path), ['other/new.ts', 'sub/in.ts', 'sub/new.ts', 'sub/uté.ts', 'top.ts']);
    assert.deepEqual(files.find((f) => f.path === 'sub/in.ts')?.ranges, [[2, 2]]);
    assert.deepEqual(files.find((f) => f.path === 'top.ts')?.ranges, [[1, 1]]);
    assert.equal(files.find((f) => f.path === 'other/new.ts')?.whole, true);
  });

  it('keeps an added line that looks like a file header inside its file', SLOW, () => {
    const dir = tmpDir();
    initRepo(dir);
    writeTree(dir, { 'a.ts': 'x\n' });
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'a');
    writeFileSync(join(dir, 'a.ts'), 'x\n++ b/evil.ts\n@@ -1 +1 @@\n');
    git(dir, 'add', 'a.ts');
    const files = JSON.parse(runNode(script, ['--base', 'HEAD'], { cwd: dir }).stdout).files as Array<{ path: string; ranges: number[][] }>;
    assert.deepEqual(files.map((f) => [f.path, f.ranges]), [['a.ts', [[2, 3]]]]);
  });
});
