import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanupTmp, git, initRepo, runNode, SLOW, tmpDir } from '../../scripts/test/helpers.ts';
import { PREFIX, create, main, realEnv, realSpawn, remove, type Env } from '../../plugins/h7/scripts/baseline-tree.ts';

cleanupTmp();

const SCRIPT = join(import.meta.dirname, '../../plugins/h7/scripts/baseline-tree.ts');

function fakeEnv(results: Array<{ status: number | null; stderr: string }>): { env: Env; calls: string[]; removed: string[] } {
  const calls: string[] = [];
  const removed: string[] = [];
  const queue = [...results];
  const env: Env = {
    spawn: (command, args) => {
      calls.push(`${command} ${args[0]}`);
      return queue.shift() ?? { status: 0, stderr: '' };
    },
    tmp: join('/', 'tmp'),
    mkdtemp: (prefix) => `${prefix}abc`,
    rm: (dir) => removed.push(dir),
  };
  return { env, calls, removed };
}

describe('baseline tree', () => {
  it('extracts the commit into the temp dir without touching the repo', () => {
    const repo = initRepo(tmpDir('h7-bl-'));
    writeFileSync(join(repo, 'a.txt'), 'one');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'a');
    const ref = git(repo, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'a.txt'), 'two');
    const before = git(repo, 'worktree', 'list', '--porcelain') + git(repo, 'status', '--short');
    const dir = create(ref, repo);
    assert.ok(dir.includes(PREFIX));
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one');
    assert.ok(!existsSync(join(dir, 'base.tar')));
    assert.equal(git(repo, 'worktree', 'list', '--porcelain') + git(repo, 'status', '--short'), before);
    remove(dir);
    assert.ok(!existsSync(dir));
  });

  it('refuses a bad ref and cleans up after any failure', () => {
    assert.throws(() => create('-x', '.'), /bad ref/);
    assert.throws(() => create('', '.'), /bad ref/);
    const a = fakeEnv([{ status: 128, stderr: 'no such ref\n' }]);
    assert.throws(() => create('nope', '.', a.env), /git archive nope failed: no such ref/);
    assert.deepEqual(a.removed, [join('/', 'tmp', `${PREFIX}abc`)]);
    const b = fakeEnv([{ status: 0, stderr: '' }, { status: 1, stderr: 'bad tar' }]);
    assert.throws(() => create('HEAD', '.', b.env), /tar failed: bad tar/);
    assert.equal(b.removed.length, 1);
    const c = fakeEnv([]);
    create('HEAD', '.', c.env);
    assert.deepEqual(c.calls, ['git archive', 'tar -xf']);
    assert.equal(c.removed.length, 1);
  });

  it('removes only baseline directories directly inside the temp dir', () => {
    const tmp = tmpDir('h7-bl-tmp-');
    const env: Env = { ...realEnv, tmp };
    const made = join(tmp, `${PREFIX}x`);
    mkdirSync(made);
    remove(made, env);
    assert.ok(!existsSync(made));
    mkdirSync(join(tmp, 'other'));
    assert.throws(() => remove(join(tmp, 'other'), env), /refusing to remove/);
    mkdirSync(join(tmp, 'deep', `${PREFIX}y`), { recursive: true });
    assert.throws(() => remove(join(tmp, 'deep', `${PREFIX}y`), env), /refusing to remove/);
    const outside = join(tmpDir('h7-bl-out-'), `${PREFIX}z`);
    mkdirSync(outside);
    assert.throws(() => remove(outside, env), /refusing to remove/);
    assert.ok(existsSync(outside));
    assert.throws(() => remove(join(tmp, `${PREFIX}missing`), env), /ENOENT/);
  });

  it('command line', () => {
    const out: string[] = [];
    const err: string[] = [];
    const { env } = fakeEnv([]);
    assert.equal(main(['create', 'HEAD'], (t) => out.push(t), (t) => err.push(t), '.', env), 0);
    assert.ok(out[0]?.includes(PREFIX));
    assert.equal(main([], () => undefined, (t) => err.push(t), '.', env), 2);
    assert.equal(main(['create'], () => undefined, (t) => err.push(t), '.', env), 2);
    assert.equal(main(['create', 'a', 'b'], () => undefined, (t) => err.push(t), '.', env), 2);
    assert.equal(main(['remove', join('/', 'nowhere', 'x')], () => undefined, (t) => err.push(t), '.', env), 2);
    assert.match(err.join('\n'), /usage/);
  });

  it('realSpawn reports status and stderr', () => {
    assert.equal(realSpawn(process.execPath, ['-e', 'process.exit(3)'], '.').status, 3);
    assert.equal(realSpawn('definitely-not-a-command-h7', [], '.').stderr, '');
  });

  it('runs as a script', SLOW, () => {
    assert.equal(runNode(SCRIPT, []).status, 2);
    const repo = initRepo(tmpDir('h7-bl-cli-'));
    const made = runNode(SCRIPT, ['create', 'HEAD'], { cwd: repo });
    assert.equal(made.status, 0);
    assert.ok(existsSync(join(made.stdout.trim(), 'README.md')));
    assert.equal(runNode(SCRIPT, ['remove', made.stdout.trim()]).status, 0);
  });
});
