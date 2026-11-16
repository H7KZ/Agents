import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  checkModels,
  coveredChanges,
  findModels,
  globToRegExp,
  main,
  MAX_GLOB,
  MAX_SOURCES,
  overall,
  parseModel,
  parseNameStatus,
  relativeProblem,
  stampedText,
  type Report,
} from '../../plugins/h7/scripts/formal-drift.ts';
import type { Runner } from '../../plugins/h7/scripts/git.ts';
import { cleanupTmp, git, initRepo, runNode, SLOW, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const SYNC = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const model = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'queue',
  kind: 'tla',
  spec: 'docs/formal/queue/Queue.tla',
  config: 'docs/formal/queue/Queue.cfg',
  check: 'tlc Queue.tla',
  sources: ['src/queue/**', 'src/index.ts'],
  sync: SYNC,
  ...extra,
});

interface Fake {
  tracked: string[];
  untracked: string[];
  diff: string;
  syncKnown: boolean;
  fail?: string;
  calls: string[][];
}

function fakeRunner(state: Partial<Fake> = {}): { run: Runner; state: Fake } {
  const s: Fake = { tracked: ['src/queue/a.ts', 'src/queue/b.ts', 'src/index.ts', 'README.md'], untracked: [], diff: '', syncKnown: true, calls: [], ...state };
  const run: Runner = (args) => {
    s.calls.push(args);
    if (args[0] === s.fail) return { status: 128, stdout: '' };
    if (args[0] === 'ls-files') return { status: 0, stdout: `${(args.includes('--others') ? s.untracked : s.tracked).join('\0')}\0` };
    if (args[0] === 'cat-file') return { status: s.syncKnown ? 0 : 128, stdout: '' };
    if (args[0] === 'diff') return { status: 0, stdout: s.diff };
    return { status: 0, stdout: `${HEAD}\n` };
  };
  return { run, state: s };
}

const z = (...parts: string[]): string => `${parts.join('\0')}\0`;

function repoWith(models: Record<string, unknown>): string {
  const root = tmpDir();
  mkdirSync(join(root, '.git'));
  for (const [name, value] of Object.entries(models)) writeTree(root, { [`docs/formal/${name}/model.json`]: typeof value === 'string' ? value : JSON.stringify(value) });
  return root;
}

function run(root: string, args: string[], runner: Runner): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = main(args, { out: (t) => (out += t), err: (t) => (err += t), cwd: root, run: runner });
  return { code, out, err };
}

describe('globs', () => {
  it('* and ? stay in a segment, ** crosses segments, **/ may match nothing', () => {
    const m = (glob: string, path: string): boolean => globToRegExp(glob).test(path);
    assert.ok(m('src/*.ts', 'src/a.ts') && !m('src/*.ts', 'src/x/a.ts') && !m('src/*.ts', 'src/a.tsx'));
    assert.ok(m('src/**', 'src/a/b/c.ts') && m('src/**', 'src/a'));
    assert.ok(m('src/**/a.ts', 'src/a.ts') && m('src/**/a.ts', 'src/x/y/a.ts') && !m('src/**/a.ts', 'src/xa.ts'));
    assert.ok(m('a?.ts', 'ab.ts') && !m('a?.ts', 'a/.ts') && !m('a?.ts', 'a.ts'));
    assert.ok(m('a+b(1).ts', 'a+b(1).ts') && !m('a.ts', 'axts'));
  });
  it('property: a plain path matches itself and its directory glob matches everything below', () => {
    const seg = fc.stringMatching(/^[a-z0-9_-]{1,6}$/);
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), fc.array(seg, { minLength: 1, maxLength: 3 }), (dirs, rest) => {
        const path = [...dirs, ...rest].join('/');
        return globToRegExp(path).test(path) && globToRegExp(`${dirs.join('/')}/**`).test(path) && !globToRegExp(`${dirs.join('/')}/*`).test(`${path}/extra/deeper`);
      }),
    );
  });
  it('relativeProblem rejects unsafe or unsupported values', () => {
    assert.equal(relativeProblem('src/a.ts', 'x', false), null);
    assert.equal(relativeProblem('src/**/*.ts', 'x', true), null);
    for (const bad of [3, '', '/abs', 'C:/x', 'a\\b', '../x', 'a/../b', 'a//b', 'a/']) assert.notEqual(relativeProblem(bad, 'x', false), null, String(bad));
    assert.match(relativeProblem('a'.repeat(MAX_GLOB + 1), 'x', false) as string, /longer/);
    for (const bad of ['a/{b,c}', 'a/[b]', '!a']) assert.match(relativeProblem(bad, 'x', true) as string, /only \* \*\* and \?/);
    assert.equal(relativeProblem('a/{b}', 'x', false), null);
  });
});

describe('parseModel', () => {
  it('accepts a full model and an optional config', () => {
    assert.equal(parseModel(model(), 'queue').errors.length, 0);
    const { config: _config, ...bare } = model();
    assert.equal(parseModel(bare, 'queue').model?.kind, 'tla');
    assert.equal(parseModel(model({ kind: 'statechart', sync: 'c'.repeat(64) }), 'queue').errors.length, 0);
  });
  it('reports every problem', () => {
    for (const [raw, pattern] of [
      [null, /name must equal/],
      [[], /name must equal/],
      [model({ name: 'other' }), /name must equal/],
      [model({ kind: 'lean' }), /kind must be/],
      [model({ spec: '../x' }), /spec must/],
      [model({ config: '' }), /config must/],
      [model({ check: ' ' }), /check must/],
      [model({ sources: [] }), /sources must be a list/],
      [model({ sources: 'src' }), /sources must be a list/],
      [model({ sources: Array(MAX_SOURCES + 1).fill('a') }), /sources must be a list/],
      [model({ sources: ['ok', '/abs'] }), /sources\[1\]/],
      [model({ sync: 'HEAD' }), /sync must be/],
      [model({ sync: 'A'.repeat(40) }), /sync must be/],
    ] as [unknown, RegExp][]) {
      const result = parseModel(raw, 'queue');
      assert.equal(result.model, null);
      assert.ok(result.errors.some((e) => pattern.test(e)), `${JSON.stringify(raw)} -> ${result.errors}`);
    }
    assert.match(parseModel(model({ name: '..' }), '..').errors[0] as string, /name must equal/);
    assert.ok(parseModel({}, 'queue').errors.length >= 5);
  });
});

describe('diff parsing', () => {
  it('parses status letters, renames and copies, ignoring empty tokens', () => {
    assert.deepEqual(parseNameStatus(z('M', 'a.ts', 'A', 'b.ts', 'R100', 'old.ts', 'new.ts', 'C75', 'x.ts', 'y.ts', 'D', 'c.ts') + '\0'), [
      { status: 'M', path: 'a.ts' },
      { status: 'A', path: 'b.ts' },
      { status: 'R', from: 'old.ts', path: 'new.ts' },
      { status: 'C', from: 'x.ts', path: 'y.ts' },
      { status: 'D', path: 'c.ts' },
    ]);
    assert.deepEqual(parseNameStatus(''), []);
  });
  it('a change counts when its new or old path is covered', () => {
    const globs = [globToRegExp('src/**')];
    const changes = [{ status: 'M', path: 'src/a.ts' }, { status: 'R', from: 'src/old.ts', path: 'lib/new.ts' }, { status: 'R', from: 'x/old.ts', path: 'lib/new.ts' }, { status: 'M', path: 'README.md' }];
    assert.deepEqual(coveredChanges(changes, globs).map((c) => c.path), ['src/a.ts', 'lib/new.ts']);
  });
  it('stampedText replaces only sync and ends with a newline', () => {
    const text = stampedText(model(), HEAD);
    assert.ok(text.endsWith('}\n'));
    assert.deepEqual({ ...JSON.parse(text), sync: SYNC }, model());
    assert.equal(JSON.parse(text).sync, HEAD);
  });
  it('overall: invalid beats drift beats in-sync', () => {
    const r = (status: Report['status']): Report => ({ name: 'n', status, changes: [], modelEdited: false, errors: [] });
    assert.deepEqual([[], [r('in-sync')], [r('in-sync'), r('drifted')], [r('unknown-sync')], [r('drifted'), r('invalid')]].map(overall), [1, 0, 1, 1, 2]);
  });
});

describe('findModels', () => {
  it('reads one level of model.json files and never follows links', () => {
    const root = repoWith({ a: model({ name: 'a' }), broken: '{', empty: '' });
    mkdirSync(join(root, 'docs/formal/nomodel'));
    writeFileSync(join(root, 'docs/formal/README.md'), '# models');
    mkdirSync(join(root, 'docs/formal/dirmodel/model.json'), { recursive: true });
    symlinkSync(tmpDir(), join(root, 'docs/formal/linked'), 'junction');
    const found = findModels(root, 'docs/formal');
    assert.deepEqual(found.map((f) => [f.name, f.readError]), [
      ['a', null],
      ['broken', 'model.json is not valid JSON'],
      ['dirmodel', 'model.json is not a regular file'],
      ['empty', 'model.json is not valid JSON'],
      ['linked', 'model directory is a symlink: not followed'],
      ['nomodel', 'model.json is missing'],
    ]);
    assert.equal(found[0]?.file, 'docs/formal/a/model.json');
    assert.deepEqual(findModels(root, 'docs/missing'), []);
  });
});

describe('checkModels', () => {
  const found = (raw: unknown, name = 'queue') => ({ name, file: `docs/formal/${name}/model.json`, raw, readError: null });
  const check = (state: Partial<Fake>, raw: unknown = model()): { report: Report; calls: string[][] } => {
    const { run, state: s } = fakeRunner(state);
    return { report: checkModels({ root: '/r', run }, 'docs/formal', [found(raw)])[0] as Report, calls: s.calls };
  };

  it('in sync when nothing covered changed, and then only the diff and cat-file ran against the sync commit', () => {
    const { report, calls } = check({ diff: z('M', 'README.md') });
    assert.deepEqual([report.status, report.changes, report.modelEdited, report.errors], ['in-sync', [], false, []]);
    assert.deepEqual(calls.find((c) => c[0] === 'diff'), ['diff', '--name-status', '-z', '-M', '--no-textconv', '--no-ext-diff', SYNC, '--']);
    assert.deepEqual(calls.find((c) => c[0] === 'cat-file'), ['cat-file', '-e', `${SYNC}^{commit}`]);
  });
  it('drifted on covered edits, deletions, moves out of the code and new untracked files', () => {
    const { report } = check({ diff: z('M', 'src/queue/a.ts', 'D', 'src/index.ts', 'R90', 'src/queue/b.ts', 'lib/b.ts', 'M', 'README.md'), untracked: ['src/queue/new.ts', 'notes.txt'] });
    assert.equal(report.status, 'drifted');
    assert.deepEqual(report.changes.map((c) => `${c.status}:${c.path}`), ['M:src/queue/a.ts', 'D:src/index.ts', 'R:lib/b.ts', 'A:src/queue/new.ts']);
  });
  it('flags a model edited since the sync without calling it drift', () => {
    for (const path of ['docs/formal/queue/Queue.tla', 'docs/formal/queue/Queue.cfg', 'docs/formal/queue/model.json']) {
      const { report } = check({ diff: z('M', path) });
      assert.deepEqual([report.status, report.modelEdited], ['in-sync', true], path);
    }
    const { config: _config, ...bare } = model();
    assert.equal(check({ diff: z('M', 'docs/formal/queue/Queue.cfg') }, bare).report.modelEdited, false);
  });
  it('unknown sync commit and dead globs are reported, never in sync', () => {
    const unknown = check({ syncKnown: false }).report;
    assert.equal(unknown.status, 'unknown-sync');
    assert.match(unknown.errors[0] as string, /sync commit is not in this repository/);
    const dead = check({}, model({ sources: ['src/queue/**', 'src/gone/**'] })).report;
    assert.equal(dead.status, 'invalid');
    assert.match(dead.errors[0] as string, /src\/gone\/\*\*/);
  });
  it('invalid models never reach git, valid ones next to them still do', () => {
    const only = fakeRunner();
    const reports = checkModels({ root: '/r', run: only.run }, 'docs/formal', [found(model({ kind: 'x' })), { name: 'torn', file: 'f', raw: null, readError: 'model.json is not valid JSON' }]);
    assert.deepEqual(reports.map((r) => r.status), ['invalid', 'invalid']);
    assert.deepEqual(only.state.calls, []);
    const mixed = fakeRunner();
    const both = checkModels({ root: '/r', run: mixed.run }, 'docs/formal', [found(model({ kind: 'x' })), found(model())]);
    assert.deepEqual(both.map((r) => r.status), ['invalid', 'in-sync']);
  });
  it('a git failure throws instead of reporting in sync', () => {
    for (const fail of ['ls-files', 'diff']) {
      const { run } = fakeRunner({ fail });
      assert.throws(() => checkModels({ root: '/r', run }, 'docs/formal', [found(model())]), new RegExp(`git ${fail} failed`));
    }
  });
});

describe('main', () => {
  it('check prints the head and one report per model, exit codes follow the worst', () => {
    const root = repoWith({ queue: model() });
    const ok = run(root, ['check'], fakeRunner().run);
    assert.equal(ok.code, 0);
    assert.deepEqual([JSON.parse(ok.out).head, JSON.parse(ok.out).models[0].status], [HEAD, 'in-sync']);
    assert.equal(run(root, ['check'], fakeRunner({ diff: z('M', 'src/index.ts') }).run).code, 1);
    assert.equal(run(repoWith({ queue: model({ sources: ['nothing/**'] }) }), ['check'], fakeRunner().run).code, 2);
    const none = run(repoWith({}), ['check'], fakeRunner().run);
    assert.deepEqual([none.code, JSON.parse(none.out)], [1, { dir: 'docs/formal', status: 'no-models', head: null, models: [] }]);
    assert.equal(run(root, ['check', '--dir', 'docs/typo'], fakeRunner().run).code, 1);
    assert.equal(JSON.parse(run(root, ['check', '--dir', 'docs/typo'], fakeRunner().run).out).status, 'no-models');
    const linkedOnly = repoWith({});
    mkdirSync(join(linkedOnly, 'docs/formal'), { recursive: true });
    symlinkSync(tmpDir(), join(linkedOnly, 'docs/formal/q'), 'junction');
    assert.equal(run(linkedOnly, ['check'], fakeRunner().run).code, 2);
    assert.equal(JSON.parse(run(root, ['check', '--dir', 'docs/formal'], fakeRunner().run).out).dir, 'docs/formal');
  });

  it('rejects bad usage, directories outside the repo and non-repositories', () => {
    const root = repoWith({ queue: model() });
    const r = fakeRunner().run;
    for (const args of [[], ['nope'], ['check', 'extra'], ['stamp'], ['stamp', 'a', 'b'], ['check', '--dir'], ['check', '--wat']]) {
      assert.equal(run(root, args, r).code, 2, args.join(' '));
      assert.match(run(root, args, r).err, /usage|option/);
    }
    assert.match(run(root, ['check', '--dir', '../x'], r).err, /--dir must be/);
    assert.match(run(root, ['check', '--dir', '/abs'], r).err, /--dir must be/);
    assert.match(run(tmpDir(), ['check'], r).err, /not inside a git repository/);
    const outside = tmpDir();
    mkdirSync(join(root, 'docs/link'), { recursive: true });
    symlinkSync(outside, join(root, 'linked'), 'junction');
    assert.match(run(root, ['check', '--dir', 'linked/sub'], r).err, /outside the repo|symlink/);
  });

  it('turns git trouble into exit 2 with a message', () => {
    const root = repoWith({ queue: model() });
    const failing = run(root, ['check'], fakeRunner({ fail: 'ls-files' }).run);
    assert.deepEqual([failing.code, failing.err], [2, 'git ls-files failed']);
    const thrown = run(root, ['check'], () => {
      throw new Error('boom');
    });
    assert.match(thrown.err, /formal-drift failed: boom/);
  });

  it('stamp sets sync to HEAD atomically, keeps other fields, and refuses unknown or invalid models', () => {
    const root = repoWith({ queue: model(), bad: model({ name: 'bad', kind: 'x' }) });
    const stamped = run(root, ['stamp', 'queue'], fakeRunner().run);
    assert.equal(stamped.code, 0);
    assert.deepEqual(JSON.parse(stamped.out), { name: 'queue', previous: SYNC, sync: HEAD, file: 'docs/formal/queue/model.json' });
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'docs/formal/queue/model.json'), 'utf8')), model({ sync: HEAD }));
    assert.match(run(root, ['stamp', 'nope'], fakeRunner().run).err, /no such model: nope/);
    assert.match(run(root, ['stamp', 'bad'], fakeRunner().run).err, /model bad is invalid: kind must be/);
    writeFileSync(join(root, 'docs/formal/queue/model.json'), JSON.stringify(model({ sync: SYNC })));
    assert.match(run(root, ['stamp', 'queue'], fakeRunner({ fail: 'rev-parse' }).run).err, /rev-parse failed/);
    assert.equal(JSON.parse(readFileSync(join(root, 'docs/formal/queue/model.json'), 'utf8')).sync, SYNC);
  });

  it('works against real git and runs as a CLI', SLOW, () => {
    const root = initRepo(tmpDir());
    writeTree(root, { 'src/queue/a.ts': 'export const a = 1;\n', 'docs/formal/queue/Queue.tla': '---- MODULE Queue ----\n' });
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'code');
    const sync = git(root, 'rev-parse', 'HEAD').trim();
    writeTree(root, { 'docs/formal/queue/model.json': JSON.stringify(model({ sources: ['src/queue/**'], config: undefined, sync })) });
    const script = join(import.meta.dirname, '../../plugins/h7/scripts/formal-drift.ts');
    const status = (): string => JSON.parse(runNode(script, ['check'], { cwd: root }).stdout).models[0].status;
    assert.equal(status(), 'in-sync');
    writeTree(root, { 'src/queue/a.ts': 'export const a = 2;\n' });
    assert.equal(status(), 'drifted');
    assert.equal(runNode(script, ['check'], { cwd: root }).status, 1);
    git(root, 'commit', '-q', '-am', 'change');
    assert.equal(runNode(script, ['stamp', 'queue'], { cwd: root }).status, 0);
    assert.equal(status(), 'in-sync');
    writeTree(root, { 'src/queue/new.ts': 'export {};\n' });
    assert.equal(status(), 'drifted');
    assert.equal(runNode(script, ['nope'], { cwd: root }).status, 2);
  });
});

