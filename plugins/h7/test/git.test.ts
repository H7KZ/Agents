import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGit, spawnRunner, type RunResult, type Runner } from '../scripts/git.ts';
import { cleanupTmp, git, initRepo, tmpDir } from '../../../scripts/test/helpers.ts';

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

describe('createGit with a fake runner', () => {
  it('parses repo root, branch and default branch', () => {
    const { run } = recorder({
      'rev-parse --show-toplevel': { status: 0, stdout: '/r\n' },
      'symbolic-ref --short -q HEAD': { status: 0, stdout: 'feature\n' },
      'symbolic-ref --short -q refs/remotes/origin/HEAD': { status: 0, stdout: 'origin/main\n' },
    });
    const g = createGit(run);
    assert.equal(g.repoRoot('/x'), '/r');
    assert.equal(g.currentBranch('/x'), 'feature');
    assert.equal(g.defaultBranch('/x', 'origin'), 'main');
  });

  it('returns null or empty on failure and empty output', () => {
    const g = createGit(recorder({ 'rev-parse --show-toplevel': { status: 0, stdout: '\n' } }).run);
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
    g.defaultBranch('/a', 'origin');
    g.defaultBranch('/a', 'origin');
    g.defaultBranch('/a', 'up');
    assert.equal(calls.length, 4);
  });

  it('caches null results too', () => {
    const { run, calls } = recorder({});
    const g = createGit(run);
    g.currentBranch('/a');
    g.currentBranch('/a');
    assert.equal(calls.length, 1);
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

  it('resolves the remote default branch when origin/HEAD exists', () => {
    const upstream = initRepo(tmpDir());
    const clone = tmpDir();
    git(clone, 'clone', '-q', upstream, 'c');
    assert.equal(createGit(spawnRunner).defaultBranch(join(clone, 'c'), 'origin'), 'main');
  });

  it('excludes staged deletions from staged files', () => {
    const dir = initRepo(tmpDir());
    git(dir, 'rm', '-q', 'README.md');
    assert.deepEqual(createGit(spawnRunner).stagedFiles(dir), []);
  });
});
