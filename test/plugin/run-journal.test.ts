import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanupTmp, initRepo, runNode, SLOW, tmpDir, git } from '../../scripts/test/helpers.ts';
import { findRoot, main, realJournalIo, type Env, type JournalIo, type Stat } from '../../plugins/h7/scripts/run-journal.ts';

cleanupTmp();

const NOW = new Date('2026-11-16T10:20:30.000Z');
const ROOT = join('/', 'repo');
const p = (...parts: string[]): string => join(ROOT, ...parts);

interface Fake extends JournalIo {
  files: Record<string, string>;
  dirs: Set<string>;
  links: Set<string>;
}

function fake(init: { files?: Record<string, string>; dirs?: string[]; links?: string[] } = {}): Fake {
  const state: Fake = {
    files: { ...init.files },
    dirs: new Set([ROOT, p('.git'), ...(init.dirs ?? [])]),
    links: new Set(init.links ?? []),
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
      state.files[path] = text;
    },
    append(path, line) {
      state.files[path] = `${state.files[path] ?? ''}${line}\n`;
    },
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

describe('run-journal start', () => {
  it('creates the run, its first event and the exclude entry', () => {
    const io = fake();
    const r = run(io, ['start', '--task', 'Add login']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0] as string), { id: ID, dir: `.h7/runs/${ID}`, journal: `.h7/runs/${ID}/journal.jsonl`, excluded: true });
    assert.ok(io.dirs.has(p('.h7', 'runs', ID)));
    assert.match(io.files[journal()] as string, /"phase":"note".*"event":"start".*"task":"Add login"/);
    assert.equal(io.files[p('.git', 'info', 'exclude')], '.h7/\n');
  });

  it('leaves an existing exclude entry alone and picks a new id on a collision', () => {
    const io = fake({ files: { [p('.git', 'info', 'exclude')]: '.h7/\n' }, dirs: [p('.h7', 'runs', ID)] });
    const r = run(io, ['start', '--task', 'Add login']);
    assert.equal(JSON.parse(r.out[0] as string).id, `${ID}-2`);
    assert.equal(io.files[p('.git', 'info', 'exclude')], '.h7/\n');
    assert.equal(JSON.parse(run(io, ['start', '--task', 'Add login']).out[0] as string).id, `${ID}-3`);
  });

  it('works without a task and reports it when .git is a file (worktree)', () => {
    const io = fake();
    io.dirs.delete(p('.git'));
    io.files[p('.git')] = 'gitdir: elsewhere';
    const r = run(io, ['start']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0] as string), { id: '20261116-102030-run', dir: '.h7/runs/20261116-102030-run', journal: '.h7/runs/20261116-102030-run/journal.jsonl', excluded: false });
  });

  it('refuses symlinked .h7 or runs', () => {
    for (const link of [p('.h7'), p('.h7', 'runs')]) {
      const r = run(fake({ links: [link] }), ['start']);
      assert.equal(r.code, 2);
      assert.match(r.err[0] as string, /refusing symlink/);
    }
  });
});

describe('run-journal append', () => {
  const started = (): Fake => {
    const io = fake();
    run(io, ['start', '--task', 'Add login']);
    return io;
  };

  it('appends a redacted event to the latest run', () => {
    const io = started();
    const r = run(io, ['append', 'decision', '{"choice":"B","token":"abc","url":"https://u:pw@h/x"}']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out[0] as string), { id: ID, phase: 'decision' });
    const last = (io.files[journal()] as string).trim().split('\n').pop() as string;
    assert.deepEqual(JSON.parse(last).data, { choice: 'B', token: '[REDACTED]', url: 'https://[REDACTED]@h/x' });
  });

  it('reads data from stdin, wraps non-objects and picks the newest of several runs', () => {
    const io = started();
    io.dirs.add(p('.h7', 'runs', '20270101-000000-later'));
    io.dirs.add(p('.h7', 'runs', 'not a valid id'));
    assert.equal(run(io, ['append', 'note', '-'], '[1,2]').code, 0);
    assert.match(io.files[journal('20270101-000000-later')] as string, /"data":\{"value":\[1,2\]\}/);
    assert.equal(run(io, ['append', '--run', ID, 'note', '"text"']).code, 0);
    assert.match(io.files[journal()] as string, /"value":"text"/);
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

  it('fails clearly with no run, and refuses symlinked run parts', () => {
    assert.match(run(fake(), ['append', 'note', '{}']).err[0] as string, /no run found/);
    for (const link of [p('.h7'), p('.h7', 'runs'), p('.h7', 'runs', ID), journal()]) {
      const io = started();
      io.links.add(link);
      const r = run(io, ['append', 'note', '{}']);
      assert.equal(r.code, 2, link);
      assert.match(r.err[0] as string, /refusing symlink/);
    }
  });
});

describe('run-journal progress and show', () => {
  const withRounds = (scores: number[]): Fake => {
    const io = fake();
    run(io, ['start', '--task', 'Add login']);
    scores.forEach((score) => {
      run(io, ['append', 'verify', JSON.stringify({ failing: score })]);
      run(io, ['append', 'loop', '{}']);
    });
    return io;
  };

  it('exits 0 while rounds improve or the streak is short, 1 at the limit', () => {
    const ok = run(withRounds([3, 2, 2]), ['progress']);
    assert.equal(ok.code, 0);
    const body = JSON.parse(ok.out[0] as string);
    assert.equal(body.streak, 1);
    assert.equal(body.stop, false);
    assert.equal(body.id, ID);
    const stuck = run(withRounds([3, 3, 3, 3, 3, 3]), ['progress']);
    assert.equal(stuck.code, 1);
    assert.equal(JSON.parse(stuck.out[0] as string).stop, true);
    assert.equal(run(withRounds([3, 3]), ['progress', '--limit', '1', '--run', ID]).code, 1);
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
    assert.equal(body.events, 5);
    assert.equal(body.phases.loop, 2);
    assert.equal(body.last.length, 2);
    assert.equal(JSON.parse(run(io, ['show']).out[0] as string).last.length, 5);
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

  it('creates the journal, excludes .h7 from git and appends whole lines', () => {
    const dir = repo();
    const outs: string[] = [];
    assert.equal(main(['start', '--task', 'Real run'], { ...env(dir), out: (t) => outs.push(t) }), 0);
    const { journal: rel } = JSON.parse(outs[0] as string);
    assert.equal(main(['append', 'verify', '{"failing":1}'], env(dir)), 0);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    const lines = readFileSync(join(dir, rel), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) JSON.parse(line);
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
    const progress = runNode(script, ['progress'], { cwd: dir });
    assert.equal(progress.status, 0);
    assert.equal(JSON.parse(progress.stdout).rounds[0].score, 3);
    assert.equal(runNode(script, ['bogus'], { cwd: dir }).status, 2);
  });
});
