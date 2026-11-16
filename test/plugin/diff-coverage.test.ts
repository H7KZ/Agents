import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { diffCoverage, globalCoverage, main, parseLcov } from '../../plugins/h7/scripts/diff-coverage.ts';
import type { ScopeFile } from '../../plugins/h7/scripts/verify-scope.ts';
import { spawnSync } from 'node:child_process';
import { cleanupTmp, runNode, SLOW, stripNodeWarnings, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const script = join(import.meta.dirname, '../../plugins/h7/scripts/diff-coverage.ts');
const opts = { lines: 100, branches: 100 };

const LCOV = [
  'TN:',
  'SF:C:\\work\\repo\\src\\a.ts',
  'DA:1,1',
  'DA:2,1',
  'DA:3,0',
  'DA:4,1,abc',
  'BRDA:2,0,0,1',
  'BRDA:2,0,1,0',
  'BRDA:4,1,0,-',
  'end_of_record',
  'SF:src/b.ts',
  'DA:1,2',
  'BRDA:1,0,0,3',
  'end_of_record',
  'DA:9,9',
].join('\r\n');

const file = (path: string, ranges: Array<[number, number]>, kind: ScopeFile['kind'] = 'source', whole = false): ScopeFile => ({ path, kind, ranges, whole });

describe('parseLcov', () => {
  it('reads lines and branches, normalising Windows paths, and ignores stray data', () => {
    const records = parseLcov(LCOV);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.file, 'C:/work/repo/src/a.ts');
    assert.deepEqual([...(records[0]?.lines ?? [])], [[1, 1], [2, 1], [3, 0], [4, 1]]);
    assert.deepEqual(records[0]?.branches, [{ line: 2, taken: true }, { line: 2, taken: false }, { line: 4, taken: false }]);
    assert.deepEqual(parseLcov('DA:1,1\nBRDA:1,0,0,1\n'), []);
    assert.deepEqual(parseLcov(''), []);
  });
});

describe('globalCoverage', () => {
  it('counts every instrumented line and branch', () => {
    const g = globalCoverage(parseLcov(LCOV));
    assert.deepEqual([g.lines.covered, g.lines.total, g.branches.covered, g.branches.total], [4, 5, 2, 4]);
    assert.equal(g.lines.pct, 80);
  });

  it('is 100% when nothing is instrumented', () => {
    assert.deepEqual(globalCoverage([]).lines, { covered: 0, total: 0, pct: 100 });
  });
});

describe('diffCoverage', () => {
  const records = parseLcov(LCOV);

  it('passes when every changed line and branch is covered', () => {
    const v = diffCoverage({ files: [file('src/a.ts', [[1, 1]]), file('src/b.ts', [], 'source', true)] }, records, opts);
    assert.equal(v.pass, true);
    assert.deepEqual(v.reasons, []);
    assert.equal(v.lines.total, 2);
    assert.equal(v.branches.total, 1);
  });

  it('lists uncovered changed lines and branches per file and fails', () => {
    const v = diffCoverage({ files: [file('src/a.ts', [[3, 4], [2, 2]])] }, records, opts);
    assert.equal(v.pass, false);
    assert.deepEqual(v.files, [{ path: 'src/a.ts', missing: false, uncoveredLines: [3], uncoveredBranches: [2, 4] }]);
    assert.match(v.reasons.join('|'), /line coverage 66\.7% is below 100%/);
    assert.match(v.reasons.join('|'), /branch coverage 33\.3% is below 100%/);
  });

  it('ignores unchanged uncovered code, tests, other files and pure deletions', () => {
    const v = diffCoverage({ files: [file('src/a.ts', [[1, 1]]), file('src/a.test.ts', [[1, 9]], 'test'), file('README.md', [[1, 1]], 'other'), file('src/gone.ts', [])] }, records, opts);
    assert.equal(v.pass, true);
    assert.deepEqual(v.files.map((f) => f.path), ['src/a.ts']);
  });

  it('fails a changed source file the report does not know', () => {
    const v = diffCoverage({ files: [file('src/c.ts', [[1, 1]]), file('xsrc/b.ts', [[1, 1]])] }, records, opts);
    assert.equal(v.pass, false);
    assert.deepEqual(v.files.map((f) => f.missing), [true, true]);
    assert.deepEqual(v.reasons, ['src/c.ts: not in the coverage report', 'xsrc/b.ts: not in the coverage report']);
  });

  it('honors lower thresholds', () => {
    const v = diffCoverage({ files: [file('src/a.ts', [[1, 4]])] }, records, { lines: 70, branches: 30 });
    assert.equal(v.pass, true);
    assert.deepEqual(v.unmeasured, []);
  });

  it('fails as unmeasured when the change has no source lines or none the report instruments', () => {
    const none = diffCoverage({ files: [] }, records, opts);
    assert.equal(none.pass, false);
    assert.deepEqual(none.unmeasured, ['(no changed source lines)']);
    const onlyTests = diffCoverage({ files: [file('src/a.test.ts', [[1, 1]], 'test'), file('src/gone.ts', [])] }, records, opts);
    assert.deepEqual(onlyTests.unmeasured, ['(no changed source lines)']);
    const outside = diffCoverage({ files: [file('src/b.ts', [[50, 60]]), file('src/a.ts', [[1, 1]])] }, records, opts);
    assert.equal(outside.pass, false);
    assert.deepEqual(outside.unmeasured, ['src/b.ts']);
    assert.match(outside.reasons.join('|'), /unmeasured, nothing to prove coverage with: src\/b\.ts/);
  });

  it('a missing file is reported as missing only, not also unmeasured', () => {
    assert.deepEqual(diffCoverage({ files: [file('src/c.ts', [[1, 1]])] }, records, opts).unmeasured, []);
  });

  it('allowUnmeasured opts out explicitly', () => {
    assert.equal(diffCoverage({ files: [] }, records, { ...opts, allowUnmeasured: true }).pass, true);
    assert.equal(diffCoverage({ files: [file('src/b.ts', [[50, 60]])] }, records, { ...opts, allowUnmeasured: true }).pass, true);
  });

  it('prefers an exact record, accepts a unique suffix match and rejects ambiguity', () => {
    const rec = (path: string, hits: number) => `SF:${path}\nDA:1,${hits}\nend_of_record\n`;
    const scope = { files: [file('src/a.ts', [[1, 1]])] };
    const exact = diffCoverage(scope, parseLcov(rec('/x/src/a.ts', 0) + rec('src/a.ts', 1)), opts);
    assert.equal(exact.pass, true);
    assert.equal(diffCoverage(scope, parseLcov(rec('/x/src/a.ts', 1)), opts).pass, true);
    assert.throws(() => diffCoverage(scope, parseLcov(rec('/x/src/a.ts', 1) + rec('/y/src/a.ts', 0)), opts), /ambiguous coverage records for src\/a\.ts: \/x\/src\/a\.ts, \/y\/src\/a\.ts/);
  });

  it('detects a global drop against a baseline, in lines or in branches', () => {
    const scope = { files: [file('src/b.ts', [[1, 1]])] };
    const same = diffCoverage(scope, records, opts, records);
    assert.equal(same.global?.dropped, false);
    assert.equal(same.pass, true);
    const lineDrop = diffCoverage(scope, parseLcov('SF:src/b.ts\nDA:1,1\nDA:2,0\nend_of_record'), opts, parseLcov('SF:src/b.ts\nDA:1,1\nDA:2,1\nend_of_record'));
    assert.equal(lineDrop.global?.dropped, true);
    assert.match(lineDrop.reasons.join('|'), /global coverage dropped/);
    const branchDrop = diffCoverage(scope, parseLcov('SF:src/b.ts\nDA:1,1\nBRDA:1,0,0,0\nend_of_record'), opts, parseLcov('SF:src/b.ts\nDA:1,1\nBRDA:1,0,0,1\nend_of_record'));
    assert.equal(branchDrop.global?.dropped, true);
    const better = diffCoverage(scope, records, opts, parseLcov('SF:src/b.ts\nDA:1,0\nBRDA:1,0,0,0\nend_of_record'));
    assert.equal(better.global?.dropped, false);
  });
});

describe('diff-coverage main', () => {
  const scope = JSON.stringify({ files: [file('src/b.ts', [[1, 1]])] });
  const reader = (files: Record<string, string>) => (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`cannot read ${path}`);
    return text;
  };
  const run = (argv: string[], files: Record<string, string>) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, (t) => out.push(t), (t) => err.push(t), reader(files));
    return { code, out: out.join(''), err: err.join('') };
  };
  const files = { 'l.info': LCOV, 's.json': scope };

  it('exits 0 with the verdict on pass and 1 on failure', () => {
    const pass = run(['--lcov', 'l.info', '--scope', 's.json', '--baseline', 'l.info'], files);
    assert.equal(pass.code, 0);
    assert.equal(JSON.parse(pass.out).pass, true);
    const failScope = JSON.stringify({ files: [file('src/a.ts', [[3, 3]])] });
    const fail = run(['--lcov', 'l.info', '--scope', 's.json'], { ...files, 's.json': failScope });
    assert.equal(fail.code, 1);
    assert.equal(JSON.parse(fail.out).pass, false);
  });

  it('takes thresholds from flags', () => {
    const failScope = JSON.stringify({ files: [file('src/a.ts', [[3, 3]])] });
    assert.equal(run(['--lcov', 'l.info', '--scope', 's.json', '--lines', '0', '--branches', '0'], { ...files, 's.json': failScope }).code, 0);
  });

  it('fails on an empty scope unless --allow-unmeasured is given, anywhere in the arguments', () => {
    const empty = { ...files, 's.json': '{"files":[]}' };
    assert.equal(run(['--lcov', 'l.info', '--scope', 's.json'], empty).code, 1);
    assert.equal(run(['--lcov', 'l.info', '--allow-unmeasured', '--scope', 's.json'], empty).code, 0);
    assert.equal(run(['--lcov', 'l.info', '--scope', 's.json', '--allow-unmeasured'], empty).code, 0);
  });

  it('reports an ambiguous record as an error', () => {
    const rec = (dir: string): string => `SF:/${dir}/src/b.ts\nDA:1,1\nend_of_record\n`;
    const r = run(['--lcov', 'l.info', '--scope', 's.json'], { 'l.info': rec('x') + rec('y'), 's.json': scope });
    assert.equal(r.code, 2);
    assert.match(r.err, /ambiguous/);
  });

  it('rejects bad usage with exit 2', () => {
    for (const argv of [[], ['--lcov', 'l.info'], ['--scope', 's.json'], ['--lcov'], ['--bogus', 'x'], ['--lcov', 'l.info', '--scope', 's.json', '--lines', 'x'], ['--lcov', 'l.info', '--scope', 's.json', '--branches', '101'], ['--lcov', 'l.info', '--scope', 's.json', '--lines', '-1']]) {
      const r = run(argv, files);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, /usage/);
    }
  });

  it('reports unreadable or wrong inputs with exit 2', () => {
    assert.match(run(['--lcov', 'nope', '--scope', 's.json'], files).err, /cannot read nope/);
    assert.match(run(['--lcov', 'l.info', '--scope', 's.json', '--baseline', 'nope'], files).err, /cannot read nope/);
    assert.match(run(['--lcov', 'l.info', '--scope', 's.json'], { ...files, 's.json': '{"x":1}' }).err, /not a verify-scope/);
    assert.equal(run(['--lcov', 'l.info', '--scope', 's.json'], { ...files, 's.json': '{' }).code, 2);
  });
});

describe('diff-coverage with node lcov output', () => {
  it('measures a real report produced by node --test', SLOW, () => {
    const dir = tmpDir();
    writeTree(dir, {
      'a.ts': 'export function f(x: number): number {\n  if (x > 0) return 1;\n  return 2;\n}\n',
      'a.test.ts': "import { test } from 'node:test';\nimport { f } from './a.ts';\ntest('x', () => { f(1); });\n",
    });
    const gen = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=lcov', '--test-reporter-destination=lcov.info', 'a.test.ts'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: undefined } });
    assert.equal(gen.status, 0, stripNodeWarnings(gen.stderr));
    const scopeFile = (ranges: Array<[number, number]>): string => {
      writeFileSync(join(dir, 'scope.json'), JSON.stringify({ files: [file('a.ts', ranges)] }));
      return 'scope.json';
    };
    const covered = runNode(script, ['--lcov', 'lcov.info', '--scope', scopeFile([[1, 1]])], { cwd: dir });
    assert.equal(covered.status, 0, covered.stdout + covered.stderr);
    const missed = runNode(script, ['--lcov', 'lcov.info', '--scope', scopeFile([[3, 3]])], { cwd: dir });
    assert.equal(missed.status, 1);
    assert.deepEqual(JSON.parse(missed.stdout).files[0].uncoveredLines, [3]);
    assert.ok(readFileSync(join(dir, 'lcov.info'), 'utf8').includes('BRDA:'));
    assert.equal(runNode(script, [], { cwd: dir }).status, 2);
  });
});
