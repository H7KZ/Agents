import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { createGit, hardenedEnv, makeSpawnRunner, resolveGitPath, spawnRunner, type RunResult, type Runner } from '../scripts/git.ts';
import { currentBranchOnDisk, findGitDirs, realDisk, remoteHeadOnDisk, type Disk } from '../scripts/gitfiles.ts';
import { cleanupTmp, git, initRepo, tmpDir, writeTree } from '../../../scripts/test/helpers.ts';

cleanupTmp();

function recorder(responses: Record<string, RunResult>): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = (args, cwd) => {
    const key = args.join(' ');
    calls.push(`${cwd}|${key}`);
    return responses[key] ?? { status: 128, stdout: '' };
  };
  return { run, calls };
}

function fakeDisk(files: Record<string, string>, dirs: string[] = []): Disk {
  const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');
  return {
    kind: (p) => (dirs.map(norm).includes(norm(p)) ? 'dir' : norm(p) in files ? 'file' : null),
    read: (p) => files[norm(p)] ?? null,
  };
}

describe('createGit with a fake runner', () => {
  it('parses the repo root and reads branch refs from disk, not from git', () => {
    const { run, calls } = recorder({ 'rev-parse --show-toplevel': { status: 0, stdout: '/r\n' } });
    const disk = fakeDisk({ '/r/.git/HEAD': 'ref: refs/heads/feature\n', '/r/.git/refs/remotes/origin/HEAD': 'ref: refs/remotes/origin/main\n' }, ['/r/.git']);
    const g = createGit(run, disk);
    assert.equal(g.repoRoot('/r'), '/r');
    assert.equal(g.currentBranch('/r'), 'feature');
    assert.equal(g.defaultBranch('/r', 'origin'), 'main');
    assert.deepEqual(calls, ['/r|rev-parse --show-toplevel']);
  });

  it('returns null or empty on failure and empty output', () => {
    const g = createGit(recorder({ 'rev-parse --show-toplevel': { status: 0, stdout: '\n' } }).run, fakeDisk({}));
    assert.equal(g.repoRoot('/x'), null);
    assert.equal(g.currentBranch('/x'), null);
    assert.equal(g.defaultBranch('/x', 'origin'), null);
    assert.equal(g.isDirty('/x'), false);
    assert.deepEqual(g.stagedFiles('/x'), []);
    assert.deepEqual(g.modifiedFiles('/x'), []);
    assert.deepEqual(g.untrackedFiles('/x'), []);
  });

  it('detects dirtiness and parses NUL separated lists', () => {
    const { run } = recorder({
      'status --porcelain': { status: 0, stdout: ' M a.ts\n' },
      'diff --cached --name-only --diff-filter=d -z': { status: 0, stdout: 'a b.ts\0.env\0' },
      'diff --name-only --relative --diff-filter=d -z': { status: 0, stdout: 'x\0' },
      'ls-files --others --exclude-standard -z': { status: 0, stdout: 'y\0z\0' },
    });
    const g = createGit(run);
    assert.equal(g.isDirty('/x'), true);
    assert.deepEqual(g.stagedFiles('/x'), ['a b.ts', '.env']);
    assert.deepEqual(g.modifiedFiles('/x'), ['x']);
    assert.deepEqual(g.untrackedFiles('/x'), ['y', 'z']);
  });

  it('memoises per method, directory and argument', () => {
    const { run, calls } = recorder({ 'rev-parse --show-toplevel': { status: 0, stdout: '/r' } });
    const g = createGit(run);
    g.repoRoot('/a');
    g.repoRoot('/a');
    g.repoRoot('/b');
    assert.equal(calls.length, 2);
    let reads = 0;
    const disk: Disk = { kind: () => null, read: () => { reads++; return null; } };
    const h = createGit(run, disk);
    h.defaultBranch('/a', 'origin');
    h.defaultBranch('/a', 'origin');
    h.currentBranch('/a');
    h.currentBranch('/a');
    assert.equal(reads, 0);
    assert.equal(h.currentBranch('/a'), null);
  });
});

describe('gitfiles', () => {
  it('finds .git directories upward, gitdir pointer files and commondir', () => {
    const disk = fakeDisk(
      {
        '/main/.git/HEAD': 'ref: refs/heads/main\n',
        '/main/.git/worktrees/w/HEAD': 'ref: refs/heads/wt\n',
        '/main/.git/worktrees/w/commondir': '../..\n',
        '/main/.git/refs/remotes/origin/HEAD': 'ref: refs/remotes/origin/trunk\n',
        '/wt/.git': 'gitdir: /main/.git/worktrees/w\n',
        '/rel/.git': 'gitdir: ../main/.git\n',
        '/bad/.git': 'garbage',
      },
      ['/main/.git'],
    );
    assert.equal(findGitDirs('/main/sub/deep', disk)?.gitDir.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/'), '/main/.git');
    assert.equal(currentBranchOnDisk('/wt/src', disk), 'wt');
    assert.equal(remoteHeadOnDisk('/wt', 'origin', disk), 'trunk');
    assert.equal(findGitDirs('/rel', disk)?.gitDir.replaceAll('\\', '/').endsWith('/main/.git'), true);
    assert.equal(findGitDirs('/bad', disk), null);
    assert.equal(findGitDirs('/nowhere', disk), null);
  });

  it('returns null for detached HEAD, odd refs, unsafe remotes and missing data', () => {
    const disk = fakeDisk({ '/a/.git/HEAD': '0123456789abcdef\n', '/b/.git/HEAD': 'ref: refs/tags/x\n', '/c/.git/refs/remotes/o/HEAD': 'ref: refs/remotes/other/x\n', '/c/.git/HEAD': '' }, ['/a/.git', '/b/.git', '/c/.git']);
    assert.equal(currentBranchOnDisk('/a', disk), null);
    assert.equal(currentBranchOnDisk('/b', disk), null);
    assert.equal(currentBranchOnDisk('/c', disk), null);
    assert.equal(remoteHeadOnDisk('/c', 'o', disk), null);
    assert.equal(remoteHeadOnDisk('/c', '../x', disk), null);
    assert.equal(remoteHeadOnDisk('/c', 'missing', disk), null);
    assert.equal(remoteHeadOnDisk('/none', 'origin', disk), null);
  });

  it('realDisk reads files and classifies paths', () => {
    const dir = tmpDir();
    writeTree(dir, { 'f.txt': 'hi' });
    assert.equal(realDisk.kind(dir), 'dir');
    assert.equal(realDisk.kind(join(dir, 'f.txt')), 'file');
    assert.equal(realDisk.kind(join(dir, 'nope')), null);
    assert.equal(realDisk.read(join(dir, 'f.txt')), 'hi');
    assert.equal(realDisk.read(join(dir, 'nope')), null);
  });
});

describe('git executable resolution', () => {
  it('only considers absolute PATH entries, never the current directory', () => {
    const seen: string[] = [];
    const found = resolveGitPath(['', '.', 'relative/bin', join(process.cwd(), 'abs')].join(delimiter), (p) => {
      seen.push(p);
      return p.endsWith('git');
    });
    assert.ok(found?.endsWith('git'));
    assert.ok(seen.every((p) => p.startsWith(process.cwd())));
    assert.equal(resolveGitPath('', () => true), null);
    assert.equal(resolveGitPath(['rel', '.'].join(delimiter), () => true), null);
    assert.equal(resolveGitPath(join(process.cwd(), 'x'), () => false), null);
  });

  it('does not find a planted git in the working directory', () => {
    const planted = tmpDir();
    writeTree(planted, { 'git.exe': 'x', git: 'x' });
    const real = resolveGitPath(process.env.PATH ?? '', (p) => realDisk.kind(p) === 'file');
    assert.ok(real !== null && !real.startsWith(planted));
  });

  it('the null runner reports failure without spawning', () => {
    assert.deepEqual(makeSpawnRunner(null)(['status'], '/'), { status: null, stdout: '' });
  });

  it('runs git with hardened configuration and environment', () => {
    const dir = initRepo(tmpDir());
    git(dir, 'config', 'core.fsmonitor', 'touch pwned.txt');
    const result = spawnRunner(['status', '--porcelain'], dir);
    assert.equal(result.status, 0);
    assert.equal(realDisk.kind(join(dir, 'pwned.txt')), null);
    const cfg = spawnRunner(['config', '--get', 'core.fsmonitor'], dir);
    assert.equal(cfg.stdout.trim(), 'false');
    const hooks = spawnRunner(['config', '--get', 'core.hooksPath'], dir);
    assert.match(hooks.stdout, /null|NUL/i);
  });

  it('forces a locked-down environment', () => {
    assert.deepEqual(hardenedEnv({ A: '1', GIT_OPTIONAL_LOCKS: '1' }), { A: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  });
});

describe('spawnRunner against real repositories', () => {
  it('reports status and stdout, and survives a missing directory', () => {
    const dir = initRepo(tmpDir());
    const ok = spawnRunner(['rev-parse', '--show-toplevel'], dir);
    assert.equal(ok.status, 0);
    assert.ok(ok.stdout.trim().length > 0);
    const missing = spawnRunner(['status'], join(dir, 'does-not-exist'));
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, '');
  });

  it('answers every question on a real repository', () => {
    const dir = initRepo(tmpDir());
    const g = createGit(spawnRunner);
    assert.equal(g.currentBranch(dir), 'main');
    assert.equal(g.isDirty(dir), false);
    assert.equal(g.defaultBranch(dir, 'origin'), null);
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', '.env'), 'X=1\n');
    writeFileSync(join(dir, 'staged.key'), 'k\n');
    git(dir, 'add', 'staged.key');
    const fresh = createGit(spawnRunner);
    assert.equal(fresh.isDirty(dir), true);
    assert.deepEqual(fresh.stagedFiles(dir), ['staged.key']);
    assert.deepEqual(fresh.modifiedFiles(dir), ['README.md']);
    assert.deepEqual(fresh.untrackedFiles(dir), ['sub/.env']);
    assert.deepEqual(fresh.modifiedFiles(join(dir, 'sub')), []);
    git(dir, 'rm', '-q', '--cached', 'staged.key');
    git(dir, 'checkout', '-q', '--detach');
    assert.equal(createGit(spawnRunner).currentBranch(dir), null);
  });

  it('resolves the remote default branch and linked worktrees from disk', () => {
    const upstream = initRepo(tmpDir());
    const clone = tmpDir();
    git(clone, 'clone', '-q', upstream, 'c');
    const repo = join(clone, 'c');
    assert.equal(createGit(spawnRunner).defaultBranch(repo, 'origin'), 'main');
    const wt = join(clone, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    const g = createGit(spawnRunner);
    assert.equal(g.currentBranch(wt), 'side');
    assert.equal(g.defaultBranch(wt, 'origin'), 'main');
  });

  it('excludes staged deletions from staged files', () => {
    const dir = initRepo(tmpDir());
    git(dir, 'rm', '-q', 'README.md');
    assert.deepEqual(createGit(spawnRunner).stagedFiles(dir), []);
  });
});
