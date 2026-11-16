import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
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
    const failed = realSpawn(process.execPath, ['-e', 'console.error("boom"); process.exit(1)'], '.');
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /boom/);
    assert.equal(realSpawn(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], tmpDir('h7-bl-cwd-')).status, 0);
  });

  it('realSpawn runs in the given cwd and bounds output', () => {
    const dir = tmpDir('h7-bl-cwd2-');
    writeFileSync(join(dir, 'marker.txt'), 'x');
    const ok = realSpawn(process.execPath, ['-e', 'process.exit(require("node:fs").existsSync("marker.txt") ? 0 : 4)'], dir);
    assert.equal(ok.status, 0);
    const big = realSpawn(process.execPath, ['-e', 'console.error("e".repeat(2 * 1024 * 1024))'], dir);
    assert.notEqual(big.status, 0);
  });

  it('runs git archive in the repo and tar in the new directory with exact arguments', () => {
    const seen: Array<{ command: string; args: string[]; cwd: string }> = [];
    const env: Env = {
      spawn: (command, args, cwd) => {
        seen.push({ command, args, cwd });
        return { status: 0, stderr: '' };
      },
      tmp: join('/', 'tmp'),
      mkdtemp: (prefix) => `${prefix}abc`,
      rm: () => undefined,
    };
    const dir = create('v1.0', join('/', 'repo'), env);
    assert.equal(dir, join('/', 'tmp', `${PREFIX}abc`));
    const tar = `${dir}${sep}base.tar`;
    assert.deepEqual(seen, [
      { command: 'git', args: ['archive', '--format=tar', `--output=${tar}`, 'v1.0'], cwd: join('/', 'repo') },
      { command: 'tar', args: ['-xf', 'base.tar'], cwd: dir },
    ]);
  });

  it('removes the tarball but keeps the directory on success, and the directory on failure', () => {
    const a = fakeEnv([]);
    const dir = create('HEAD', '.', a.env);
    assert.deepEqual(a.removed, [`${dir}${sep}base.tar`]);
    const b = fakeEnv([{ status: 1, stderr: '  spaced  \n' }]);
    assert.throws(() => create('HEAD', '.', b.env), (e: Error) => e.message === 'git archive HEAD failed: spaced');
    assert.deepEqual(b.removed, [join('/', 'tmp', `${PREFIX}abc`)]);
    const c = fakeEnv([{ status: 0, stderr: '' }, { status: null, stderr: '\nnope \n' }]);
    assert.throws(() => create('HEAD', '.', c.env), (e: Error) => e.message === 'tar failed: nope');
  });

  it('rejects refs that merely resemble flags or are empty, accepts others', () => {
    assert.throws(() => create('--output=x', '.', fakeEnv([]).env), (e: Error) => e.message === 'bad ref: "--output=x"');
    assert.throws(() => create('', '.', fakeEnv([]).env), (e: Error) => e.message === 'bad ref: ""');
    const ok = fakeEnv([]);
    assert.doesNotThrow(() => create('a-b', '.', ok.env));
    assert.doesNotThrow(() => create(' ', '.', fakeEnv([]).env));
  });

  it('remove deletes the resolved target, and refuses names that only contain the prefix', () => {
    const tmp = tmpDir('h7-bl-tmp2-');
    const removed: string[] = [];
    const env: Env = { ...realEnv, tmp, rm: (d) => removed.push(d) };
    const good = join(tmp, `${PREFIX}ok`);
    mkdirSync(good);
    remove(good, env);
    assert.deepEqual(removed, [good]);
    const infix = join(tmp, `x${PREFIX}ok`);
    mkdirSync(infix);
    assert.throws(() => remove(infix, env), /refusing to remove/);
    assert.throws(() => remove(tmp, env), /refusing to remove/);
    assert.throws(() => remove(join(tmp, `${PREFIX}ok`, '..', 'other'), env), /ENOENT|refusing/);
    assert.deepEqual(removed, [good]);
    const mapped: string[] = [];
    const env2: Env = { ...env, rm: (d) => mapped.push(d) };
    remove('alias', env2, (p) => (p === 'alias' ? good : tmp));
    assert.deepEqual(mapped, [good]);
  });

  it('main prints the created path with forward slashes and reports errors', () => {
    const out: string[] = [];
    const err: string[] = [];
    const env: Env = { ...fakeEnv([]).env, tmp: join('C:', 'tmp', 'x') };
    assert.equal(main(['create', 'HEAD'], (t) => out.push(t), (t) => err.push(t), '.', env), 0);
    assert.deepEqual(out, [`${join('C:', 'tmp', 'x', `${PREFIX}abc`).split(sep).join('/')}`]);
    assert.ok(!out[0]?.includes('\\'));
    assert.equal(err.length, 0);
    const bad = fakeEnv([{ status: 128, stderr: 'fatal' }]);
    assert.equal(main(['create', 'nope'], () => undefined, (t) => err.push(t), '.', bad.env), 2);
    assert.deepEqual(err, ['git archive nope failed: fatal']);
    err.length = 0;
    assert.equal(main(['bogus', 'x'], () => undefined, (t) => err.push(t), '.', env), 2);
    assert.equal(main(['remove', 'a', 'b'], () => undefined, (t) => err.push(t), '.', env), 2);
    assert.equal(main(['remove'], () => undefined, (t) => err.push(t), '.', env), 2);
    assert.deepEqual(err, ['usage: baseline-tree.ts create <ref> | remove <dir>', 'usage: baseline-tree.ts create <ref> | remove <dir>', 'usage: baseline-tree.ts create <ref> | remove <dir>']);
  });

  it('realEnv.rm deletes recursively and tolerates a missing path', () => {
    const dir = tmpDir('h7-bl-rm-');
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x');
    realEnv.rm(join(dir, 'a'));
    assert.ok(!existsSync(join(dir, 'a')));
    assert.doesNotThrow(() => realEnv.rm(join(dir, 'never-existed')));
  });

  it('main remove deletes a real baseline directory and prints nothing', () => {
    const tmp = tmpDir('h7-bl-tmp3-');
    const made = join(tmp, `${PREFIX}m`);
    mkdirSync(made);
    const out: string[] = [];
    assert.equal(main(['remove', made], (t) => out.push(t), () => undefined, '.', { ...realEnv, tmp }), 0);
    assert.deepEqual(out, []);
    assert.ok(!existsSync(made));
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
