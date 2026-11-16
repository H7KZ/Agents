import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { createGit, hardenedEnv, makeSpawnRunner, resolveGitPath, spawnRunner, type RunResult, type Runner } from '../../plugins/h7/scripts/git.ts';
import { currentBranchOnDisk, findGitDirs, realDisk, remoteHeadOnDisk, type Disk } from '../../plugins/h7/scripts/gitfiles.ts';
import { SLOW, cleanupTmp, git, initRepo, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

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
  const repoDisk = (extra: Record<string, string> = {}) =>
    fakeDisk({ '/r/.git/HEAD': 'ref: refs/heads/feature\n', '/r/.git/refs/remotes/origin/HEAD': 'ref: refs/remotes/origin/main\n', ...extra }, ['/r/.git']);

  it('parses the repo root and reads branch refs from disk, not from git', () => {
    const { run, calls } = recorder({ 'rev-parse --show-toplevel': { status: 0, stdout: '/r\n' } });
    const g = createGit(run, repoDisk());
    assert.equal(g.repoRoot('/r'), '/r');
    assert.equal(g.currentBranch('/r'), 'feature');
    assert.equal(g.defaultBranch('/r', 'origin'), 'main');
    assert.deepEqual(calls, ['/r|rev-parse --show-toplevel']);
  });

  it('answers "not a repository" from disk without spawning git', () => {
    const { run, calls } = recorder({});
    const g = createGit(run, fakeDisk({}));
    assert.equal(g.repoRoot('/x'), null);
    assert.equal(g.currentBranch('/x'), null);
    assert.equal(g.defaultBranch('/x', 'origin'), null);
    assert.equal(g.trackedDirty('/x'), false);
    assert.deepEqual(g.stagedFiles('/x'), []);
    assert.deepEqual(g.modifiedFiles('/x'), []);
    assert.deepEqual(g.untrackedFiles('/x'), []);
    assert.deepEqual(g.ignoredFiles('/x'), []);
    assert.deepEqual(calls, []);
  });

  it('inside a repository every failure throws instead of reporting a clean tree', () => {
    for (const status of [128, 1, null]) {
      const failing = () => createGit(() => ({ status, stdout: '' }), repoDisk());
      assert.throws(() => failing().repoRoot('/r'), /git rev-parse failed/, String(status));
      assert.throws(() => failing().trackedDirty('/r'), /git rev-parse failed/);
    }
    const empty = createGit(() => ({ status: 0, stdout: '\n' }), repoDisk());
    assert.throws(() => empty.repoRoot('/r'), /no repository root/);
  });

  it('each query throws when its own git command fails', () => {
    const run: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '/r\n' } : { status: 128, stdout: 'partial\0' });
    for (const query of ['trackedDirty', 'stagedFiles', 'modifiedFiles', 'untrackedFiles', 'ignoredFiles'] as const) {
      const g = createGit(run, repoDisk());
      assert.throws(() => g[query]('/r'), /failed \(status 128\)/, query);
    }
  });

  it('detects tracked dirtiness and parses NUL separated lists from the repository root', () => {
    const { run, calls } = recorder({
      'rev-parse --show-toplevel': { status: 0, stdout: '/r\n' },
      'status --porcelain --untracked-files=no': { status: 0, stdout: ' M a.ts\n' },
      'diff --cached --name-only --diff-filter=d -z': { status: 0, stdout: 'a b.ts\0.env\0' },
      'diff --name-only --diff-filter=d -z': { status: 0, stdout: 'x\0' },
      'ls-files --others --exclude-standard -z': { status: 0, stdout: 'y\0z\0' },
      'ls-files --others --ignored --exclude-standard --directory -z': { status: 0, stdout: 'node_modules/\0.env\0' },
    });
    const g = createGit(run, repoDisk());
    assert.equal(g.trackedDirty('/r/sub'), true);
    assert.deepEqual(g.stagedFiles('/r/sub'), ['a b.ts', '.env']);
    assert.deepEqual(g.modifiedFiles('/r/sub'), ['x']);
    assert.deepEqual(g.untrackedFiles('/r/sub'), ['y', 'z']);
    assert.deepEqual(g.ignoredFiles('/r/sub'), ['node_modules/', '.env']);
    assert.ok(calls.filter((c) => !c.includes('rev-parse')).every((c) => c.startsWith('/r|')));
  });

  it('a clean tracked tree is not dirty', () => {
    const run: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '/r' } : { status: 0, stdout: '\n' });
    assert.equal(createGit(run, repoDisk()).trackedDirty('/r'), false);
  });

  it('memoises per method, directory and argument', () => {
    const { run, calls } = recorder({ 'rev-parse --show-toplevel': { status: 0, stdout: '/r' } });
    const g = createGit(run, repoDisk());
    g.repoRoot('/r');
    g.repoRoot('/r');
    g.repoRoot('/r/sub');
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

  it('does not find a planted git in the working directory', SLOW, () => {
    const planted = tmpDir();
    writeTree(planted, { 'git.exe': 'x', git: 'x' });
    const real = resolveGitPath(process.env.PATH ?? '', (p) => realDisk.kind(p) === 'file');
    assert.ok(real !== null && !real.startsWith(planted));
  });

  it('the null runner reports failure without spawning', () => {
    assert.deepEqual(makeSpawnRunner(null)(['status'], '/'), { status: null, stdout: '' });
  });

  it('runs git with hardened configuration and environment', SLOW, () => {
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
    assert.deepEqual(hardenedEnv({ A: '1', GIT_OPTIONAL_LOCKS: '1' }), { A: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  });
});

describe('spawnRunner against real repositories', SLOW, () => {
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
    assert.equal(g.trackedDirty(dir), false);
    assert.equal(g.defaultBranch(dir, 'origin'), null);
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', '.env'), 'X=1\n');
    writeFileSync(join(dir, 'staged.key'), 'k\n');
    git(dir, 'add', 'staged.key');
    const fresh = createGit(spawnRunner);
    assert.equal(fresh.trackedDirty(dir), true);
    assert.deepEqual(fresh.stagedFiles(dir), ['staged.key']);
    assert.deepEqual(fresh.modifiedFiles(dir), ['README.md']);
    assert.deepEqual(fresh.untrackedFiles(dir), ['sub/.env']);
    assert.deepEqual(fresh.modifiedFiles(join(dir, 'sub')), ['README.md']);
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
