import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { run, type Deps } from '../../plugins/h7/scripts/guard-core.ts';
import type { Runner, RunResult } from '../../plugins/h7/scripts/git.ts';
import { BACKUP_PREFIX, KEEP, removeQuietly, stamp, takeSnapshot } from '../../plugins/h7/scripts/snapshot.ts';
import { cleanupTmp, runs, tmpDir } from '../../scripts/test/helpers.ts';
import { repoDisk } from './support.ts';

cleanupTmp();

const NOW = new Date('2026-02-03T04:05:06.789Z');
const ok = (stdout = ''): RunResult => ({ status: 0, stdout });
const fail: RunResult = { status: 1, stdout: '' };

interface Script {
  calls: { args: string[]; env?: Record<string, string>; cwd?: string }[];
  refs?: string[];
  failOn?: string;
  throwOn?: string;
  empty?: string;
}

const subcommand = (args: string[]): string => (args[0] === '-c' ? (args[2] as string) : (args[0] as string));

/** A scripted git: answers the snapshot steps, fails or throws on the named subcommand. */
function scripted(script: Script): Runner {
  return (args, cwd, env) => {
    script.calls.push({ args, env, cwd });
    const key = subcommand(args);
    if (script.throwOn === key) throw new Error('git timed out');
    if (script.failOn === key) return fail;
    if (script.empty === key) return ok('\n');
    switch (key) {
      case 'rev-parse':
        return args.includes('--absolute-git-dir') ? ok('/repo/.git\n') : ok('abc\n');
      case 'write-tree':
        return ok('tree1\n');
      case 'commit-tree':
        return ok('commit1\n');
      case 'for-each-ref':
        return ok((script.refs ?? []).join('\n'));
      default:
        return ok();
    }
  };
}

const take = (script: Script, removed: string[] = []) =>
  takeSnapshot('/repo', 'git reset --hard', { runner: scripted(script), now: () => NOW, remove: (p) => removed.push(p), pid: 42 });
const fwd = (path: string | undefined): string | undefined => path?.replace(/\\/g, '/');

describe('takeSnapshot', () => {
  it('seeds a temporary index from HEAD, stages everything, writes a commit on HEAD and a new ref, then removes the index', () => {
    const script: Script = { calls: [] };
    const removed: string[] = [];
    const result = take(script, removed);
    const ref = `${BACKUP_PREFIX}20260203T040506Z-001`;
    assert.deepEqual(result, { ok: true, ref });
    assert.deepEqual(script.calls.map((c) => subcommand(c.args)), ['rev-parse', 'rev-parse', 'read-tree', 'add', 'write-tree', 'commit-tree', 'for-each-ref', 'update-ref', 'rev-parse']);
    const index = `/repo/.git/h7-snapshot-42-${NOW.getTime()}.idx`;
    for (const call of script.calls.filter((c) => ['read-tree', 'add', 'write-tree', 'commit-tree'].includes(subcommand(c.args)))) {
      assert.equal(fwd(call.env?.GIT_INDEX_FILE), index);
      assert.ok(call.env?.GIT_AUTHOR_NAME && call.env.GIT_COMMITTER_EMAIL);
    }
    const commit = script.calls.find((c) => subcommand(c.args) === 'commit-tree')?.args as string[];
    assert.deepEqual(commit.slice(0, 3), ['-c', 'commit.gpgsign=false', 'commit-tree']);
    assert.ok(commit.includes('-p') && commit.includes('HEAD'));
    assert.deepEqual(script.calls.find((c) => c.args[0] === 'update-ref')?.args, ['update-ref', ref, 'commit1', ''], 'empty old value: the ref must not exist yet');
    assert.deepEqual(removed.map((p) => fwd(p)), [index]);
  });

  it('numbers refs within the same second and puts a redacted one-line command in the message', () => {
    const base = `${BACKUP_PREFIX}20260203T040506Z-`;
    const script: Script = { calls: [], refs: [`${base}001`, `${base}002`, `${BACKUP_PREFIX}20250101T000000Z-001`] };
    const command = `git reset --hard\n  --token=sk-abcdefghijklmnopqrstuvwxyz123456 #${'x'.repeat(400)}`;
    const result = takeSnapshot('/repo', command, { runner: scripted(script), now: () => NOW, remove: () => {} });
    assert.deepEqual(result, { ok: true, ref: `${base}003` });
    const message = script.calls.find((c) => subcommand(c.args) === 'commit-tree')?.args.at(-1) as string;
    assert.match(message, /^h7 backup before: git reset --hard --token=\[REDACTED\]/);
    assert.ok(!message.includes('\n') && message.length <= 'h7 backup before: '.length + 200);
  });

  it('keeps the newest KEEP refs and prunes the rest, ignoring prune failures', () => {
    const many = Array.from({ length: KEEP + 2 }, (_, i) => `${BACKUP_PREFIX}20250101T0000${String(i).padStart(2, '0')}Z-001`);
    const script: Script = { calls: [], refs: [...many].reverse() };
    assert.equal(take(script).ok, true);
    const deleted = script.calls.filter((c) => c.args[0] === 'update-ref' && c.args[1] === '-d').map((c) => c.args[2]);
    assert.deepEqual(deleted, many.slice(0, 3));
    const flaky: Runner = (args, cwd, env) => (args[1] === '-d' ? fail : scripted({ calls: [], refs: many })(args, cwd, env));
    assert.equal(takeSnapshot('/repo', 'x', { runner: flaky, now: () => NOW, remove: () => {} }).ok, true);
  });

  it('prunes only well-formed names, never the new ref, and keeps the newest KEEP including it', () => {
    const odd = [`${BACKUP_PREFIX}evil`, `${BACKUP_PREFIX}20250101T000000Z-1`, 'refs/heads/main', `${BACKUP_PREFIX}20250101T000000Z-001/extra`];
    const newer = Array.from({ length: KEEP + 4 }, (_, i) => `${BACKUP_PREFIX}2030010${i % 10}T0000${String(i).padStart(2, '0')}Z-001`);
    const script: Script = { calls: [], refs: [...odd, ...newer] };
    const result = take(script) as { ok: true; ref: string };
    assert.equal(result.ok, true);
    const deleted = script.calls.filter((c) => c.args[1] === '-d').map((c) => c.args[2] as string);
    assert.ok(!deleted.includes(result.ref), 'the ref just created is the oldest by stamp and still survives');
    assert.ok(deleted.every((name) => !odd.includes(name)), 'names outside the format are never touched');
    assert.deepEqual(deleted, [...newer].sort().slice(0, newer.length - KEEP));
  });

  it('verifies the new ref resolves after pruning, and fails closed when it does not', () => {
    const asked: string[][] = [];
    const verifying: Runner = (args, cwd, env) => {
      asked.push(args);
      return args[0] === 'rev-parse' && args.some((a) => a.startsWith(BACKUP_PREFIX)) ? fail : scripted({ calls: [] })(args, cwd, env);
    };
    assert.deepEqual(takeSnapshot('/repo', 'x', { runner: verifying, now: () => NOW, remove: () => {} }), { ok: false, reason: 'the new backup ref does not resolve' });
    assert.equal(asked.at(-1)?.at(-1), `${BACKUP_PREFIX}20260203T040506Z-001^{commit}`);
  });

  it('fails closed at every step, still removing the temporary index', () => {
    for (const step of ['read-tree', 'add', 'write-tree', 'commit-tree', 'for-each-ref', 'update-ref']) {
      const removed: string[] = [];
      assert.equal(take({ calls: [], failOn: step }, removed).ok, false, step);
      assert.equal(removed.length, 1, step);
    }
    assert.equal(take({ calls: [], empty: 'write-tree' }).ok, false);
    assert.equal(take({ calls: [], empty: 'commit-tree' }).ok, false);
  });

  it('fails when git cannot name its directory or has no HEAD, and when a step throws', () => {
    const removed: string[] = [];
    const noDir: Runner = (args) => (args.includes('--absolute-git-dir') ? ok('\n') : ok('x'));
    assert.deepEqual(takeSnapshot('/repo', 'x', { runner: noDir, now: () => NOW, remove: (p) => removed.push(p) }), { ok: false, reason: 'cannot locate the git directory' });
    const badDir: Runner = (args) => (args.includes('--absolute-git-dir') ? fail : ok('x'));
    assert.equal(takeSnapshot('/repo', 'x', { runner: badDir, now: () => NOW }).ok, false);
    const noHead: Runner = (args) => (args.includes('--verify') ? fail : ok('/repo/.git\n'));
    assert.match((takeSnapshot('/repo', 'x', { runner: noHead, now: () => NOW }) as { reason: string }).reason, /no commit/);
    assert.deepEqual(removed, [], 'no index was created yet');
    assert.deepEqual(take({ calls: [], throwOn: 'add' }, removed), { ok: false, reason: 'git timed out' });
    assert.equal(removed.length, 1);
  });

  it('formats UTC stamps and removes quietly', () => {
    assert.equal(stamp(NOW), '20260203T040506Z');
    const dir = tmpDir();
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'f'), 'x');
    removeQuietly(join(dir, 'd'));
    assert.ok(existsSync(join(dir, 'd', 'f')), 'a non-empty directory is not removed and nothing throws');
    writeFileSync(join(dir, 'idx'), 'x');
    removeQuietly(join(dir, 'idx'));
    assert.equal(existsSync(join(dir, 'idx')), false);
    removeQuietly(join(dir, 'never-existed'));
  });

  it('default remove and pid are used when not injected', () => {
    const script: Script = { calls: [] };
    assert.equal(takeSnapshot('/repo', 'x', { runner: scripted(script), now: () => NOW }).ok, true);
    assert.ok(script.calls.some((c) => c.env?.GIT_INDEX_FILE?.includes(`h7-snapshot-${process.pid}-`)));
  });

  it('property: the ref is under refs/h7/backup and the commit message is one line', () => {
    fc.assert(
      fc.property(fc.string(), (junk) => {
        const script: Script = { calls: [] };
        const result = takeSnapshot('/repo', `git reset --hard ${junk}`, { runner: scripted(script), now: () => NOW, remove: () => {} });
        assert.ok(result.ok && result.ref.startsWith(BACKUP_PREFIX));
        const message = script.calls.find((c) => subcommand(c.args) === 'commit-tree')?.args.at(-1) as string;
        assert.ok(!/[\r\n]/.test(message));
      }),
      { numRuns: runs(100) },
    );
  });
});

/** The guard around the snapshot, with a scripted git so every branch is reachable on any platform. */
describe('guard: destructive git on a dirty tree', () => {
  const home = tmpDir();
  const guardRunner = (script: Script, dirty: string): Runner => (args, cwd, env) => {
    if (args[0] === 'status') return ok(dirty);
    if (args[0] === 'ls-files') return ok('');
    return scripted(script)(args, cwd, env);
  };
  const deps = (runner: Runner, over: Partial<Deps> = {}): Deps => ({
    platform: 'posix',
    runner,
    realpath: (p) => p,
    disk: repoDisk,
    homedir: home,
    tmpdir: '/nonexistent-tmp',
    fallbackCwd: '/fallback',
    now: () => NOW,
    readConfig: () => null,
    probe: { kind: () => null, head: () => null },
    ...over,
  });
  const call = (command: string, runner: Runner, env: Record<string, string | undefined> = { H7_HOME: home }, over: Partial<Deps> = {}) =>
    run(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' }), env, deps(runner, over));
  const REF = `${BACKUP_PREFIX}20260203T040506Z-001`;
  const dirty = ' M a.txt\n';

  it('snapshots then allows, naming the ref and the restore command', () => {
    const script: Script = { calls: [] };
    const result = call('git reset --hard', guardRunner(script, dirty));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`saved a recovery snapshot as ${REF} .*git restore --source=${REF} --worktree -- \\.`));
    assert.ok(script.calls.some((c) => c.args[0] === 'update-ref'));
  });

  it('uses the dedicated snapshot runner when one is given', () => {
    const script: Script = { calls: [] };
    const result = call('git reset --hard', guardRunner({ calls: [] }, dirty), { H7_HOME: home }, { snapshotRunner: scripted(script) });
    assert.equal(result.code, 0);
    assert.ok(script.calls.length > 0);
  });

  it('applies in every ask mode', () => {
    for (const ask of ['prompt', 'allow', 'deny']) {
      assert.equal(call('git reset --hard', guardRunner({ calls: [] }, dirty), { H7_HOME: home, H7_GUARD_ASK: ask }).code, 0, ask);
    }
  });

  it('keeps the block when any snapshot step fails', () => {
    const result = call('git reset --hard', guardRunner({ calls: [], failOn: 'write-tree' }, dirty));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /blocked \[destructive-git-dirty\]/);
  });

  it('keeps the block for git clean -x, whose ignored files no snapshot holds', () => {
    const script: Script = { calls: [] };
    const result = call('git clean -fdx', (args, cwd, env) => (args[0] === 'ls-files' ? ok('x\0') : guardRunner(script, '')(args, cwd, env)));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ignored files/);
    assert.ok(!script.calls.some((c) => c.args[0] === 'update-ref'));
  });

  /** Two repositories, /repo and /other; git answers per directory it is run in. */
  const twoDisk = { kind: (p: string) => (/\/(repo|other)\/\.git$/.test(p.split(String.fromCharCode(92)).join('/')) ? ('dir' as const) : null), read: () => null };
  const perDir = (script: Script, failIn?: string): Runner => (args, cwd, env) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(`${cwd}\n`);
    if (cwd === failIn && args[0] === 'write-tree') return fail;
    return guardRunner(script, dirty)(args, cwd, env);
  };
  const callIn = (command: string, runner: Runner) => call(command, runner, { H7_HOME: home }, { disk: twoDisk });
  const snapshotDirs = (script: Script): string[] => script.calls.filter((c) => c.args[0] === 'update-ref' && c.args[1] !== '-d').map((c) => c.cwd as string);

  it('snapshots the repository the command targets, not the hook cwd (-C and cd)', () => {
    for (const command of ['git -C /other reset --hard', 'cd /other && git reset --hard']) {
      const script: Script = { calls: [] };
      const result = callIn(command, perDir(script));
      assert.equal(result.code, 0, command);
      assert.deepEqual(snapshotDirs(script), ['/other'], command);
    }
  });

  it('snapshots each distinct target repository once', () => {
    const script: Script = { calls: [] };
    const result = callIn('git reset --hard && git -C /other reset --hard && git -C /repo clean -fd', perDir(script));
    assert.equal(result.code, 0);
    assert.deepEqual(snapshotDirs(script).sort(), ['/other', '/repo']);
    assert.equal((result.stderr.match(/refs\/h7\/backup\//g) ?? []).length, 4, 'both refs named in the note and in each restore hint');
  });

  it('keeps the block when any one target fails to snapshot', () => {
    const result = callIn('git reset --hard && git -C /other reset --hard', perDir({ calls: [] }, '/other'));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /destructive-git-dirty/);
  });

  it('keeps the block for a target the guard could not resolve (cd to an unknown place, --git-dir)', () => {
    const script: Script = { calls: [] };
    assert.equal(callIn('cd "$SOMEWHERE" && git reset --hard', perDir(script)).code, 2);
    assert.match(callIn('git --git-dir=/other/data reset --hard', perDir(script)).stdout, /destructive-git-unresolved/);
    assert.equal(callIn('GIT_DIR=/other/.git git reset --hard', perDir(script)).code, 2);
    assert.equal(callIn('GIT_WORK_TREE=/other git reset --hard', perDir(script)).code, 2);
    assert.ok(!script.calls.some((c) => c.args[0] === 'update-ref'));
    assert.equal(callIn('git --git-dir=/other/.git reset --hard', perDir(script)).code, 2);
  });

  it('a clean flag learned in one repository never counts for another, per flag', () => {
    const script: Script = { calls: [] };
    const runner: Runner = (args, cwd, env) => {
      if (args[0] === 'status') return ok('');
      if (args[0] === 'ls-files') return ok('x ');
      return perDir(script)(args, cwd, env);
    };
    const result = callIn('git -C /repo clean -fd && git -C /other commit -a -m x && git -C /other clean -fd', runner);
    assert.equal(result.code, 0);
    assert.deepEqual(snapshotDirs(script).sort(), ['/other', '/repo']);
  });

  it('property: any redirector on a destructive call keeps the block (no snapshot)', () => {
    const redirectors = ['-c core.worktree=/other', '-c core.hooksPath=/x', '--config-env=core.worktree=V', '--git-dir=/other/.git', '--work-tree=/other', '--namespace=n', '--super-prefix=p/', '--exec-path=/x', '--attr-source=HEAD'];
    const envs = ['GIT_DIR=/other/.git', 'git_dir=/other/.git', 'Git_Work_Tree=/other', 'GIT_COMMON_DIR=/x', 'GIT_INDEX_FILE=/x', 'GIT_CONFIG_COUNT=1', 'GIT_CONFIG_GLOBAL=/x', 'GIT_SOMETHING_NEW=1'];
    const subs = ['reset --hard', 'checkout .', 'restore .', 'clean -fd'];
    fc.assert(
      fc.property(fc.constantFrom(...subs), fc.option(fc.constantFrom(...redirectors), { nil: undefined }), fc.option(fc.constantFrom(...envs), { nil: undefined }), (sub, option, env) => {
        fc.pre(option !== undefined || env !== undefined);
        const script: Script = { calls: [] };
        const command = `${env === undefined ? '' : `${env} `}git ${option === undefined ? '' : `${option} `}${sub}`;
        const result = callIn(command, (args, cwd, e) => (args[0] === 'ls-files' ? ok('x ') : perDir(script)(args, cwd, e)));
        assert.ok(!script.calls.some((c) => c.args[0] === 'update-ref'), command);
        assert.ok(result.code === 2 || result.stdout.includes('"ask"'), command);
      }),
      { numRuns: runs(150) },
    );
  });

  it('keeps every other block: skipping hooks in the same chain is still blocked and nothing is snapshotted', () => {
    const script: Script = { calls: [] };
    const result = call('git reset --hard && git commit --no-verify -m x', guardRunner(script, dirty));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /blocked \[(?!destructive-git-dirty)[a-z-]+\]/);
    assert.ok(!script.calls.some((c) => c.args[0] === 'update-ref'));
  });

  it('still applies an ask that sits next to the snapshotted command, with the note first', () => {
    const result = call('git reset --hard && git stash drop', guardRunner({ calls: [] }, dirty));
    assert.match(result.stdout, /git-stash-drop/);
    assert.match(result.stderr, /recovery snapshot/);
    const denied = call('git reset --hard && git stash drop', guardRunner({ calls: [] }, dirty), { H7_HOME: home, H7_GUARD_ASK: 'deny' });
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /^h7 guard: saved a recovery snapshot[\s\S]*ask mode is deny/);
  });

  it('logs the allow with the ref, and says so when the log cannot be written', () => {
    const logHome = tmpDir();
    call('git reset --hard', guardRunner({ calls: [] }, dirty), { H7_HOME: logHome });
    const line = JSON.parse(readFileSync(join(logHome, '.h7', 'guard.log'), 'utf8').trim().split('\n')[0] as string);
    assert.deepEqual([line.decision, line.rule, line.ref], ['allow', 'destructive-git-snapshot', REF]);
    const blocked = tmpDir();
    writeFileSync(join(blocked, '.h7'), 'a file');
    assert.match(call('git reset --hard', guardRunner({ calls: [] }, dirty), { H7_HOME: blocked }).stderr, /could not write guard log/);
  });

  it('a clean tree needs no snapshot and spawns none', () => {
    const script: Script = { calls: [] };
    assert.deepEqual(call('git reset --hard', guardRunner(script, '')), { code: 0, stdout: '', stderr: '' });
    assert.ok(!script.calls.some((c) => c.args[0] === 'update-ref'));
  });
});
