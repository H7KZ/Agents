import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanupTmp, git, initRepo, runNode, SLOW, tmpDir } from '../../scripts/test/helpers.ts';
import { findRoot, main, MAX_LINE_BYTES, realJournalIo, type Env, type JournalIo, type Stat } from '../../plugins/h7/scripts/run-journal.ts';
import { LAYERS, freshState, setLayer } from '../../plugins/h7/scripts/verify-state.ts';

cleanupTmp();

const NOW = new Date('2026-11-16T10:20:30.000Z');
const ROOT = join('/', 'repo');
const p = (...parts: string[]): string => join(ROOT, ...parts);

interface Fake extends JournalIo {
  files: Record<string, string>;
  dirs: Set<string>;
  links: Set<string>;
  /** What git reports as info/exclude; null means git cannot say. */
  exclude: string | null;
  order: string[];
}

function fake(init: { files?: Record<string, string>; dirs?: string[]; links?: string[] } = {}): Fake {
  const state: Fake = {
    files: { ...init.files },
    dirs: new Set([ROOT, p('.git'), ...(init.dirs ?? [])]),
    links: new Set(init.links ?? []),
    exclude: p('.git', 'info', 'exclude'),
    order: [],
    now: () => NOW,
    lstat(path): Stat | null {
      const link = state.links.has(path);
      const dir = state.dirs.has(path);
      if (!link && !dir && !(path in state.files)) return null;
      return { isSymbolicLink: () => link, isDirectory: () => dir };
    },
    mkdir(path) {
      state.dirs.add(path);
    },
    read: (path) => state.files[path] ?? null,
    readdir: (path) => [...state.dirs].filter((d) => d !== path && join(d, '..') === path).map((d) => d.slice(path.length + 1)),
    write(path, text) {
      state.order.push(`write ${path}`);
      state.files[path] = text;
    },
    append(path, line) {
      state.order.push(`append ${path}`);
      state.files[path] = `${state.files[path] ?? ''}${line}\n`;
    },
    excludePath: () => state.exclude,
  };
  return state;
}

function run(io: JournalIo, args: string[], stdin = '', cwd = ROOT): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: Env = { io, out: (t) => out.push(t), err: (t) => err.push(t), stdin: () => stdin, cwd };
  return { code: main(args, env), out, err };
}

const ID = '20261116-102030-add-login';
const journal = (id = ID): string => p('.h7', 'runs', id, 'journal.jsonl');
const CURRENT = p('.h7', 'runs', 'CURRENT');
const EXCLUDE = p('.git', 'info', 'exclude');

describe('run-journal start', () => {
  it('excludes .h7 first, then creates the run, its first event and CURRENT', () => {
    const io = fake();
    const r = run(io, ['start', '--task', 'Add login']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0] as string), { id: ID, dir: `.h7/runs/${ID}`, journal: `.h7/runs/${ID}/journal.jsonl`, exclude: EXCLUDE, excluded: true });
    assert.ok(io.dirs.has(p('.h7', 'runs', ID)));
    assert.match(io.files[journal()] as string, /"phase":"note".*"event":"start".*"task":"Add login"/);
    assert.equal(io.files[EXCLUDE], '.h7/\n');
    assert.equal(io.files[CURRENT], `${ID}\n`);
    assert.deepEqual(io.order, [`write ${EXCLUDE}`, `append ${journal()}`, `write ${CURRENT}`]);
  });

  it('leaves an existing exclude entry alone and picks a new id on a collision', () => {
    const io = fake({ files: { [EXCLUDE]: '.h7/\n' }, dirs: [p('.h7', 'runs', ID)] });
    const r = run(io, ['start', '--task', 'Add login']);
    assert.equal(JSON.parse(r.out[0] as string).id, `${ID}-2`);
    assert.ok(!io.order.includes(`write ${EXCLUDE}`));
    assert.equal(JSON.parse(run(io, ['start', '--task', 'Add login']).out[0] as string).id, `${ID}-3`);
    assert.equal(io.files[CURRENT], `${ID}-3\n`);
  });

  it('writes the exclude entry where git says, for a worktree sharing the main repository exclude', () => {
    const io = fake();
    io.exclude = join('/', 'main', '.git', 'info', 'exclude');
    io.dirs.delete(p('.git'));
    io.files[p('.git')] = 'gitdir: /main/.git/worktrees/w';
    const r = run(io, ['start']);
    assert.equal(r.code, 0);
    assert.equal(io.files[io.exclude], '.h7/\n');
    assert.deepEqual(JSON.parse(r.out[0] as string), { id: '20261116-102030-run', dir: '.h7/runs/20261116-102030-run', journal: '.h7/runs/20261116-102030-run/journal.jsonl', exclude: io.exclude, excluded: true });
  });

  it('writes nothing at all when git cannot say where the exclude file is', () => {
    const io = fake();
    io.exclude = null;
    const r = run(io, ['start']);
    assert.equal(r.code, 2);
    assert.match(r.err[0] as string, /cannot locate the git exclude file/);
    assert.deepEqual(io.order, []);
    assert.ok(!io.dirs.has(p('.h7', 'runs')));
  });

  it('refuses symlinked .h7, runs or CURRENT', () => {
    for (const link of [p('.h7'), p('.h7', 'runs'), CURRENT]) {
      const io = fake({ links: [link] });
      const r = run(io, ['start']);
      assert.equal(r.code, 2);
      assert.match(r.err[0] as string, /refusing symlink/);
      assert.deepEqual(io.order, []);
    }
  });
});

describe('run-journal append', () => {
  const started = (): Fake => {
    const io = fake();
    run(io, ['start', '--task', 'Add login']);
    return io;
  };

  it('appends a redacted event to the CURRENT run', () => {
    const io = started();
    const r = run(io, ['append', 'decision', '{"choice":"B","token":"abc","url":"https://u:p@ss@h/x"}']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0] as string), { id: ID, phase: 'decision' });
    const last = (io.files[journal()] as string).trim().split('\n').pop() as string;
    assert.deepEqual(JSON.parse(last).data, { choice: 'B', token: '[REDACTED]', url: 'https://[REDACTED]@h/x' });
  });

  it('reads data from stdin, wraps non-objects, and an explicit --run beats CURRENT', () => {
    const io = started();
    io.dirs.add(p('.h7', 'runs', '20270101-000000-other'));
    io.dirs.add(p('.h7', 'runs', 'not a valid id'));
    assert.equal(run(io, ['append', 'note', '-'], '[1,2]').code, 0);
    assert.match(io.files[journal()] as string, /"data":\{"value":\[1,2\]\}/);
    assert.equal(run(io, ['append', '--run', '20270101-000000-other', 'note', '"text"']).code, 0);
    assert.match(io.files[journal('20270101-000000-other')] as string, /"value":"text"/);
  });

  it('uses the only run when there is no CURRENT file, and refuses to guess between several', () => {
    const one = fake({ dirs: [p('.h7', 'runs', ID)] });
    assert.equal(run(one, ['append', 'note', '{}']).code, 0);
    assert.ok(journal() in one.files);
    const two = fake({ dirs: [p('.h7', 'runs', 'b-run'), p('.h7', 'runs', 'a-run')] });
    const r = run(two, ['append', 'note', '{}']);
    assert.equal(r.code, 2);
    assert.match(r.err[0] as string, /several runs and no CURRENT file: pass --run <id> \(a-run, b-run\)/);
    assert.equal(Object.keys(two.files).length, 0);
    const blank = fake({ files: { [CURRENT]: ' \n' }, dirs: [p('.h7', 'runs', ID)] });
    assert.equal(run(blank, ['append', 'note', '{}']).code, 0);
  });

  it('rejects bad arguments without writing', () => {
    const io = started();
    const before = JSON.stringify(io.files);
    for (const args of [['append'], ['append', 'note'], ['append', 'deploy', '{}'], ['append', 'note', '{}', 'extra'], ['append', 'note', '{bad'], ['append', '--bogus', 'x', 'note', '{}'], ['append', '--run'], ['append', '--run', '../x', 'note', '{}'], ['append', '--run', 'missing', 'note', '{}']]) {
      const r = run(io, args);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.out.length, 0);
    }
    assert.equal(JSON.stringify(io.files), before);
  });

  it('rejects loop, verify and review events with a missing or invalid count instead of scoring them as zero', () => {
    const io = started();
    const before = JSON.stringify(io.files);
    for (const [phase, data] of [
      ['loop', '{"failing":"0","unresolved":0}'],
      ['loop', '{"failing":0,"unresolved":-1}'],
      ['loop', '{"failing":1.5,"unresolved":0}'],
      ['loop', '{"incomplete":0,"unresolved":0}'],
      ['loop', '{"failing":0}'],
      ['loop', '{}'],
      ['verify', '{"failing":"none"}'],
      ['review', '{"unresolved":null}'],
    ] as const) {
      const r = run(io, ['append', phase, data]);
      assert.equal(r.code, 2, `${phase} ${data}`);
      assert.match(r.err[0] as string, /failing|unresolved/);
    }
    assert.equal(JSON.stringify(io.files), before);
    for (const [phase, data] of [['loop', '{"round":1,"failing":["unit"],"unresolved":0}'], ['verify', '{"step":"start"}'], ['verify', '{"failing":0}'], ['review', '{"unresolved":["F1"]}']] as const) assert.equal(run(io, ['append', phase, data]).code, 0, `${phase} ${data}`);
  });

  it('fails clearly with no run, a bad CURRENT, and refuses symlinked run parts', () => {
    assert.match(run(fake(), ['append', 'note', '{}']).err[0] as string, /no run found/);
    const bad = fake({ files: { [CURRENT]: '../x' } });
    assert.match(run(bad, ['append', 'note', '{}']).err[0] as string, /bad run id/);
    for (const link of [p('.h7'), p('.h7', 'runs'), CURRENT, p('.h7', 'runs', ID), journal()]) {
      const io = started();
      io.links.add(link);
      const r = run(io, ['append', 'note', '{}']);
      assert.equal(r.code, 2, link);
      assert.match(r.err[0] as string, /refusing symlink/);
    }
  });
});

describe('run-journal progress and show', () => {
  const withRounds = (scores: number[], run0 = true): Fake => {
    const io = fake();
    if (run0) run(io, ['start', '--task', 'Add login']);
    for (const score of scores) run(io, ['append', 'loop', JSON.stringify({ failing: score, unresolved: 0 })]);
    return io;
  };
  const allPass = (): string => {
    let state = freshState(NOW);
    for (const layer of LAYERS) state = setLayer(state, layer, 'pass', 'ok', NOW);
    return JSON.stringify(state);
  };
  const proven = (n: number): string => JSON.stringify({ kept: Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}` })), rejected: [] });

  it('exits 0 while the best score keeps being beaten or the streak is short, 1 at 5 stuck rounds', () => {
    const ok = run(withRounds([3, 2, 2]), ['progress']);
    assert.equal(ok.code, 0);
    const body = JSON.parse(ok.out[0] as string);
    assert.equal(body.streak, 1);
    assert.equal(body.stop, false);
    assert.equal(body.id, ID);
    assert.equal(run(withRounds([3, 3, 3, 3]), ['progress']).code, 0);
    const stuck = run(withRounds([3, 3, 3, 3, 3]), ['progress']);
    assert.equal(stuck.code, 1);
    assert.equal(JSON.parse(stuck.out[0] as string).stop, true);
    assert.equal(run(withRounds([5, 3, 5, 3, 5, 3, 5, 3]), ['progress']).code, 1);
  });

  it('lets --limit lower the brake and never raise it above 5', () => {
    assert.equal(run(withRounds([3, 3]), ['progress', '--limit', '2', '--run', ID]).code, 1);
    const high = run(withRounds([3, 3, 3, 3, 3]), ['progress', '--limit', '50']);
    assert.equal(high.code, 1);
    assert.equal(JSON.parse(high.out[0] as string).limit, 5);
  });

  it('cross-checks verify.json and proven.json and never says clean when they disagree', () => {
    const agree = withRounds([0]);
    assert.equal(JSON.parse(run(agree, ['progress']).out[0] as string).clean, true);
    agree.files[p('.h7', 'verify.json')] = allPass();
    agree.files[p('.h7', 'review', 'proven.json')] = proven(0);
    const ok = JSON.parse(run(agree, ['progress']).out[0] as string);
    assert.equal(ok.clean, true);
    assert.deepEqual(ok.observed, { failing: 0, unresolved: 0, unreadable: [] });

    const failing = withRounds([0]);
    failing.files[p('.h7', 'verify.json')] = JSON.stringify(freshState(NOW));
    const f = JSON.parse(run(failing, ['progress']).out[0] as string);
    assert.equal(f.clean, false);
    assert.match(f.warnings[0], /reported failing 0 but \.h7\/verify\.json shows 10/);

    const open = withRounds([0]);
    open.files[p('.h7', 'review', 'proven.json')] = proven(2);
    const o = JSON.parse(run(open, ['progress']).out[0] as string);
    assert.equal(o.clean, false);
    assert.match(o.warnings[0], /unresolved 0 but \.h7\/review\/proven\.json shows 2/);

    const garbage = withRounds([0]);
    garbage.files[p('.h7', 'verify.json')] = 'garbage';
    garbage.files[p('.h7', 'review', 'proven.json')] = '{"kept":3}';
    const g = JSON.parse(run(garbage, ['progress']).out[0] as string);
    assert.equal(g.clean, false);
    assert.deepEqual(g.observed.unreadable, ['.h7/verify.json', '.h7/review/proven.json']);
  });

  it('tolerates corrupt lines and reports them', () => {
    const io = withRounds([2]);
    io.files[journal()] += 'garbage\n{"ts":"x"';
    const body = JSON.parse(run(io, ['progress']).out[0] as string);
    assert.equal(body.corrupt, 2);
    assert.equal(body.rounds.length, 1);
  });

  it('treats a missing journal file as empty', () => {
    const io = fake({ dirs: [p('.h7', 'runs', ID)] });
    assert.equal(JSON.parse(run(io, ['progress']).out[0] as string).rounds.length, 0);
  });

  it('shows counts and the tail', () => {
    const io = withRounds([2, 1]);
    const body = JSON.parse(run(io, ['show', '--tail', '2']).out[0] as string);
    assert.equal(body.events, 3);
    assert.equal(body.phases.loop, 2);
    assert.equal(body.last.length, 2);
    assert.equal(JSON.parse(run(io, ['show']).out[0] as string).last.length, 3);
  });

  it('rejects bad numbers and options', () => {
    const io = withRounds([1]);
    for (const args of [['progress', '--limit', '0'], ['progress', '--limit', 'x'], ['progress', '--limit', '-1'], ['show', '--tail', '0'], ['show', '--limit', '1']]) assert.equal(run(io, args).code, 2, args.join(' '));
  });
});

describe('run-journal entry', () => {
  it('prints usage for no or unknown commands, and fails outside a repository', () => {
    for (const args of [[], ['nope']]) {
      const r = run(fake(), args);
      assert.equal(r.code, 2);
      assert.match(r.err[0] as string, /usage: run-journal/);
    }
    const loose = fake();
    loose.dirs.delete(p('.git'));
    assert.match(run(loose, ['start']).err[0] as string, /not inside a git repository/);
  });

  it('reports unexpected io errors without throwing', () => {
    const io = fake();
    io.mkdir = () => {
      throw new Error('disk full');
    };
    const r = run(io, ['start']);
    assert.equal(r.code, 2);
    assert.match(r.err[0] as string, /run-journal failed: disk full/);
  });

  it('finds the repository root from a nested directory, and not above it', () => {
    const io = fake();
    assert.equal(findRoot(p('a', 'b'), io), ROOT);
    assert.equal(findRoot(ROOT, io), ROOT);
    io.dirs.delete(p('.git'));
    assert.equal(findRoot(p('a', 'b'), io), null);
  });
});

describe('run-journal on disk', () => {
  const repo = (): string => initRepo(tmpDir());
  const env = (dir: string, stdin = ''): Env => ({ io: realJournalIo, out: () => undefined, err: () => undefined, stdin: () => stdin, cwd: dir });

  it('creates the journal, CURRENT, excludes .h7 from git and appends whole lines', () => {
    const dir = repo();
    const outs: string[] = [];
    assert.equal(main(['start', '--task', 'Real run'], { ...env(dir), out: (t) => outs.push(t) }), 0);
    const { id, journal: rel } = JSON.parse(outs[0] as string);
    assert.equal(readFileSync(join(dir, '.h7', 'runs', 'CURRENT'), 'utf8'), `${id}\n`);
    assert.equal(main(['append', 'loop', '{"failing":1,"unresolved":0}'], env(dir)), 0);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    const lines = readFileSync(join(dir, rel), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) JSON.parse(line);
  });

  it('excludes .h7 through git for a linked worktree, where .git is a file', () => {
    const dir = repo();
    const tree = join(tmpDir(), 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'side', tree);
    assert.ok(readFileSync(join(tree, '.git'), 'utf8').startsWith('gitdir:'));
    assert.equal(main(['start'], env(tree)), 0);
    assert.equal(git(tree, 'status', '--porcelain'), '');
    assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.h7\/$/m);
  });

  it('writes nothing when git cannot answer', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, '.git'));
    assert.equal(realJournalIo.excludePath(dir), null);
    assert.equal(main(['start'], env(dir)), 2);
    assert.ok(!existsSync(join(dir, '.h7')));
  });

  it('reports the exclude path git gives for a plain repository', () => {
    const dir = repo();
    assert.equal(realJournalIo.excludePath(dir)?.toLowerCase(), join(dir, '.git', 'info', 'exclude').toLowerCase());
  });

  it('starts a new line after a torn last line and handles an empty file', () => {
    const dir = repo();
    const outs: string[] = [];
    main(['start'], { ...env(dir), out: (t) => outs.push(t) });
    const file = join(dir, JSON.parse(outs[0] as string).journal);
    writeFileSync(file, '{"ts":"2026');
    assert.equal(main(['append', 'note', '{"a":1}'], env(dir)), 0);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith('{"ts":"2026\n{'));
    assert.ok(text.endsWith('\n'));
    writeFileSync(file, '');
    assert.equal(main(['append', 'note', '{"a":2}'], env(dir)), 0);
    assert.ok(readFileSync(file, 'utf8').startsWith('{'));
  });

  it('refuses an oversized line and a hardlinked journal', (t) => {
    const dir = repo();
    const file = join(dir, 'log.jsonl');
    assert.throws(() => realJournalIo.append(file, 'x'.repeat(MAX_LINE_BYTES + 1)), /over 65536 bytes/);
    assert.ok(!existsSync(file));
    realJournalIo.append(file, 'x'.repeat(MAX_LINE_BYTES));
    const alias = join(dir, 'alias.jsonl');
    try {
      linkSync(file, alias);
    } catch {
      t.skip('cannot create hard links here');
      return;
    }
    assert.throws(() => realJournalIo.append(file, '{}'), /hardlinked/);
    assert.throws(() => realJournalIo.append(alias, '{}'), /hardlinked/);
  });

  it('works from a subdirectory and on a missing directory read', () => {
    const dir = repo();
    mkdirSync(join(dir, 'sub'));
    assert.equal(main(['start'], env(join(dir, 'sub'))), 0);
    assert.ok(existsSync(join(dir, '.h7', 'runs')));
    assert.deepEqual(realJournalIo.readdir(join(dir, 'nope')), []);
    assert.equal(realJournalIo.read(join(dir, 'nope')), null);
    assert.equal(realJournalIo.lstat(join(dir, 'nope')), null);
    assert.ok(realJournalIo.now() instanceof Date);
  });

  it('refuses a real symlinked .h7 when the platform allows creating one', (t) => {
    const dir = repo();
    const elsewhere = tmpDir();
    try {
      symlinkSync(elsewhere, join(dir, '.h7'), 'junction');
    } catch {
      t.skip('cannot create symlinks here');
      return;
    }
    assert.equal(main(['start'], env(dir)), 2);
    assert.deepEqual(realJournalIo.readdir(elsewhere), []);
  });

  it('runs as a CLI', SLOW, () => {
    const dir = repo();
    const script = join(import.meta.dirname, '../../plugins/h7/scripts/run-journal.ts');
    assert.equal(runNode(script, ['start', '--task', 'cli'], { cwd: dir }).status, 0);
    assert.equal(runNode(script, ['append', 'loop', '-'], { cwd: dir, input: '{"failing":2,"unresolved":1}' }).status, 0);
    assert.equal(runNode(script, ['append', 'loop', '-'], { cwd: dir, input: '{"failing":"2","unresolved":1}' }).status, 2);
    const progress = runNode(script, ['progress'], { cwd: dir });
    assert.equal(progress.status, 0);
    assert.equal(JSON.parse(progress.stdout).rounds[0].score, 3);
    assert.equal(runNode(script, ['bogus'], { cwd: dir }).status, 2);
  });
});
