import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanupTmp, git, initRepo, tmpDir } from '../../scripts/test/helpers.ts';
import { makeStore } from '../../plugins/h7/scripts/ci-watch.ts';
import { spawnRunner } from '../../plugins/h7/scripts/git.ts';
import { gate } from '../../plugins/h7/scripts/verify-gate.ts';
import { main as journal, realJournalIo, type Env } from '../../plugins/h7/scripts/run-journal.ts';
import { main as retro } from '../../plugins/h7/scripts/retro-rows.ts';
import { main as stateMain, realStateIo, stateFile } from '../../plugins/h7/scripts/verify-state.ts';
import { computeScope, defaultBase, main as scopeMain } from '../../plugins/h7/scripts/verify-scope.ts';
import { bulkRunner, type Runner } from '../../plugins/h7/scripts/git.ts';
import { MARKER, placeOf, realFsIo } from '../../plugins/h7/scripts/workspace.ts';

cleanupTmp();

const TABLE = '## Rule <-> enforcer\n\n| Rule | Enforcer |\n|---|---|\n| Existing rule | `lint` |\n';

/** <home>/team holds two real git repos and a marker; nothing of h7 may ever appear inside web or server. */
function workspace(marker: unknown = { version: 1, repos: { web: { base: 'develop' }, server: {} } }): { ws: string; home: string; web: string; server: string } {
  const home = tmpDir('h7-wire-home-');
  const ws = join(home, 'team');
  mkdirSync(ws);
  const web = initRepo((mkdirSync(join(ws, 'web')), join(ws, 'web')));
  const server = initRepo((mkdirSync(join(ws, 'server')), join(ws, 'server')));
  writeFileSync(join(ws, MARKER), typeof marker === 'string' ? marker : JSON.stringify(marker));
  writeFileSync(join(ws, 'AGENTS.md'), `# Workspace\n\n${TABLE}`);
  return { ws, home, web, server };
}

/** Everything the acceptance test says must not change inside a repo. */
function fingerprint(repo: string): string {
  const exclude = join(repo, '.git', 'info', 'exclude');
  return JSON.stringify({
    status: git(repo, 'status', '--short', '--ignored'),
    exclude: existsSync(exclude) ? readFileSync(exclude, 'utf8') : null,
    worktrees: git(repo, 'worktree', 'list', '--porcelain'),
    top: readdirSync(repo).sort(),
    git: readdirSync(join(repo, '.git')).sort(),
  });
}

const withHome = <T>(home: string, body: () => T): T => {
  const previous = process.env.H7_HOME;
  process.env.H7_HOME = home;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.H7_HOME;
    else process.env.H7_HOME = previous;
  }
};

const jenv = (cwd: string, home: string, out: string[] = []): Env => ({ io: realJournalIo, out: (t) => out.push(t), err: (t) => out.push(`ERR ${t}`), stdin: () => '', cwd, home });

describe('workspace mode wiring', () => {
  it('placeOf keeps state in the repo without a marker and in the workspace with one', () => {
    const { ws, home, web } = workspace();
    const plain = placeOf(join(tmpDir('h7-plain-'), 'x'), { ...realFsIo, lstat: () => null }, home);
    assert.deepEqual([plain.workspace, plain.parts], [false, ['.h7']]);
    const place = placeOf(web, realFsIo, home);
    assert.deepEqual([place.workspace, place.state, place.contain, place.parts, place.agents], [true, join(ws, '.h7', 'web'), ws, ['.h7', 'web'], join(ws, 'AGENTS.md')]);
  });

  it('leaves both repos byte for byte untouched while every script runs in workspace mode', () => {
    const { ws, home, web, server } = workspace();
    const before = [fingerprint(web), fingerprint(server)];
    const out: string[] = [];
    const sub = join(web, 'src');
    mkdirSync(sub);
    const noise = (): void => {
      // untracked source in src is the only change a task makes; the fingerprint is taken after it
    };
    noise();
    const mid = fingerprint(web);

    withHome(home, () => {
      assert.equal(stateMain(['init'], (t) => out.push(t), (t) => out.push(t), sub), 0);
      assert.equal(stateMain(['set', 'lint', 'pass', 'ok'], (t) => out.push(t), (t) => out.push(t), sub), 0);
      assert.ok(existsSync(join(ws, '.h7', 'web', 'verify.json')));
      assert.equal(stateFile(sub), join(ws, '.h7', 'web', 'verify.json'));
      assert.equal(JSON.parse(gate(JSON.stringify({ cwd: sub })).stdout).decision, 'block');

      assert.equal(journal(['start', '--task', 'wiring'], jenv(sub, home, out)), 0);
      assert.equal(journal(['append', 'loop', '{"failing":1,"unresolved":0}'], jenv(sub, home, out)), 0);
      assert.equal(journal(['progress'], jenv(sub, home, out)), 0);
      assert.equal(journal(['show'], jenv(sub, home, out)), 0);

      const store = makeStore(sub, spawnRunner);
      assert.equal(store.prepare(), true);
      assert.equal(store.save('sha', [{ key: 'CI/a', at: '2026-11-16T11:00:00.000Z' }]), true);
      assert.deepEqual(store.load('sha'), [{ key: 'CI/a', at: '2026-11-16T11:00:00.000Z' }]);

      const rows = JSON.stringify([{ rule: 'workspace rule', enforcer: '`test/x.test.ts`', kind: 'test', evidence: 'run 1: reverted' }]);
      const renv = (stdout: string[]) => ({ out: (t: string) => stdout.push(t), err: (t: string) => stdout.push(t), stdin: () => '', cwd: sub, home });
      const proposed: string[] = [];
      assert.equal(retro(['propose', rows], renv(proposed)), 0);
      const signals: string[] = [];
      assert.equal(retro(['signals'], renv(signals)), 0);
      assert.equal(JSON.parse(signals[0] as string).runs.length, 1);
      const applied: string[] = [];
      assert.equal(retro(['apply', 'r1', '--write'], renv(applied)), 0, applied.join());
      assert.equal(JSON.parse(applied[0] as string).file, 'AGENTS.md');
      assert.match(readFileSync(join(ws, 'AGENTS.md'), 'utf8'), /workspace rule/);
    });

    for (const file of ['runs', 'retro/rows.json', 'ci-watch.json', 'verify.json']) assert.ok(existsSync(join(ws, '.h7', 'web', file)), file);
    assert.equal(fingerprint(web), mid);
    assert.equal(fingerprint(server), before[1]);
    assert.ok(!existsSync(join(web, '.h7')) && !existsSync(join(server, '.h7')));
    assert.equal(readFileSync(join(web, '.git', 'info', 'exclude'), 'utf8').includes('.h7'), false);
  });

  it('keeps a repo that is not listed on the old in-repo behavior', () => {
    const { home, server } = workspace({ version: 1, repos: { web: {} } });
    withHome(home, () => {
      assert.equal(journal(['start'], jenv(server, home)), 0);
      assert.equal(stateMain(['init'], () => undefined, () => undefined, server), 0);
    });
    assert.ok(existsSync(join(server, '.h7', 'runs', 'CURRENT')));
    assert.ok(existsSync(join(server, '.h7', 'verify.json')));
    assert.match(readFileSync(join(server, '.git', 'info', 'exclude'), 'utf8'), /^\.h7\/$/m);
  });

  it('retro-rows applies to --file relative to the workspace root and journal start refuses to run with a bad marker', () => {
    const { ws, home, web } = workspace();
    writeFileSync(join(ws, 'docs.md'), TABLE);
    const out: string[] = [];
    const renv = { out: (t: string) => out.push(t), err: (t: string) => out.push(t), stdin: () => '', cwd: web, home };
    assert.equal(retro(['propose', JSON.stringify([{ rule: 'r', enforcer: '`e`', kind: 'lint', evidence: 'x' }])], renv), 0);
    assert.equal(retro(['apply', 'r1', '--file', 'docs.md', '--write'], renv), 0, out.join());
    assert.match(readFileSync(join(ws, 'docs.md'), 'utf8'), /\| r \|/);
    writeFileSync(join(ws, MARKER), '{bad');
    const errs: string[] = [];
    assert.equal(journal(['start'], { ...jenv(web, home), err: (t) => errs.push(t) }), 2);
    assert.match(errs[0] as string, /not valid JSON/);
    assert.equal(retro(['list'], { ...renv, err: (t: string) => errs.push(t) }), 2);
    assert.equal(stateMain(['init'], () => undefined, (t) => errs.push(t), web), 2);
  });

  it('a malformed marker makes the stop gate allow with a message, the CI store inert and verify-state fail', () => {
    const { ws, home, web } = workspace('{nope');
    withHome(home, () => {
      const result = gate(JSON.stringify({ cwd: web }));
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /not valid JSON/);
      const store = makeStore(web, spawnRunner);
      assert.deepEqual([store.load('s'), store.prepare(), store.save('s', [])], [[], false, false]);
      const errs: string[] = [];
      assert.equal(stateMain(['check'], () => undefined, (t) => errs.push(t), web), 2);
      assert.match(errs[0] as string, /\.h7-workspace\.json/);
      const other: string[] = [];
      assert.equal(stateMain(['check'], () => undefined, (t) => other.push(t), web, realStateIo), 2);
    });
    assert.ok(!existsSync(join(ws, '.h7')));
  });

  it('verify-state reports a non-workspace failure of the resolver as a failure, not a crash', () => {
    const errs: string[] = [];
    const bad = { ...realFsIo };
    assert.equal(typeof bad.lstat, 'function');
    // A cwd that makes path handling throw: an embedded NUL byte.
    assert.equal(stateMain(['check'], () => undefined, (t) => errs.push(t), undefined as unknown as string), 2);
    assert.match(errs[0] as string, /workspace failed/);
  });
});

describe('base branch resolution', () => {
  const repo = (): string => initRepo(tmpDir('h7-base-'));

  it('uses origin/HEAD before main, and falls back to develop', () => {
    const dir = repo();
    git(dir, 'branch', '-m', 'main', 'trunk');
    git(dir, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    assert.equal(defaultBase(bulkRunner, dir, null), 'origin/trunk');
    assert.equal(computeScope(bulkRunner, dir).base, 'origin/trunk');

    const dev = repo();
    git(dev, 'branch', '-m', 'main', 'develop');
    assert.equal(defaultBase(bulkRunner, dev, null), 'develop');
    const none = repo();
    git(none, 'branch', '-m', 'main', 'weird');
    assert.equal(defaultBase(bulkRunner, none, null), undefined);
    assert.throws(() => computeScope(bulkRunner, none), /origin\/HEAD.*develop/);
  });

  it('a dangling origin/HEAD is skipped and the usual names still work', () => {
    const dir = repo();
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
    assert.equal(defaultBase(bulkRunner, dir, null), 'main');
  });

  it('prefers the configured base (remote copy first) and errors clearly when it is missing', () => {
    const dir = repo();
    git(dir, 'branch', 'develop');
    assert.equal(defaultBase(bulkRunner, dir, 'develop'), 'develop');
    git(dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    assert.equal(defaultBase(bulkRunner, dir, 'develop'), 'origin/develop');
    assert.throws(() => defaultBase(bulkRunner, dir, 'nope'), /configured base nope is not a commit/);
    assert.equal(computeScope(bulkRunner, dir, undefined, 'develop').base, 'origin/develop');
    assert.equal(computeScope(bulkRunner, dir, 'main', 'develop').base, 'main');
  });

  it('the command line picks the workspace base for a listed repo', () => {
    const { home, web } = workspace();
    git(web, 'branch', 'develop');
    const out: string[] = [];
    const run: Runner = bulkRunner;
    withHome(home, () => assert.equal(scopeMain([], (t) => out.push(t), (t) => out.push(t), web, run), 0));
    assert.equal(JSON.parse(out[0] as string).base, 'develop');
    const errs: string[] = [];
    writeFileSync(join(home, 'team', MARKER), '{nope');
    withHome(home, () => assert.equal(scopeMain([], () => undefined, (t) => errs.push(t), web, run), 2));
    assert.match(errs[0] as string, /not valid JSON/);
  });
});
