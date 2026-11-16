import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanupTmp, git, initRepo, runNode, tmpDir } from '../../scripts/test/helpers.ts';

cleanupTmp();

const script = join(import.meta.dirname, '..', '..', 'plugins', 'h7', 'scripts', 'guard.ts');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  home: string;
}

function guard(command: string, cwd: string, extra: { tool?: string; home?: string; env?: Record<string, string> } = {}): Run {
  const home = extra.home ?? tmpDir('h7-home-');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: extra.tool ?? 'Bash', tool_input: { command }, cwd });
  const result = runNode(script, [], { input, cwd: tmpDir(), env: { H7_HOME: home, ...extra.env } });
  return { ...result, home };
}

const logLines = (home: string): Record<string, string>[] =>
  readFileSync(join(home, '.h7', 'guard.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('guard.ts as a hook subprocess', () => {
  const decision = (run: Run): string => (run.status === 2 ? 'block' : run.stdout.includes('"ask"') ? 'ask' : 'allow');

  it('allows ordinary commands with no output and no log', () => {
    const repo = initRepo(tmpDir());
    const run = guard('git status && ls', repo);
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '');
  });

  it('blocks force pushes to main using the real current branch', () => {
    const repo = initRepo(tmpDir());
    const run = guard('git push --force', repo);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /\[force-push-protected\].*"main"/);
    assert.equal(logLines(run.home)[0]?.rule, 'force-push-protected');
    git(repo, 'checkout', '-q', '-b', 'topic');
    assert.equal(guard('git push --force', repo).status, 0);
  });

  it('asks before a plain push to main', () => {
    const repo = initRepo(tmpDir());
    const run = guard('git push', repo);
    assert.equal(run.status, 0);
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });

  it('honours the remote HEAD branch as protected', () => {
    const upstream = initRepo(tmpDir());
    git(upstream, 'branch', '-m', 'trunk');
    const parent = tmpDir();
    git(parent, 'clone', '-q', upstream, 'clone');
    const clone = join(parent, 'clone');
    assert.equal(guard('git push -f origin trunk', clone).status, 2);
    assert.equal(guard('git push -f origin other', clone).status, 0);
  });

  it('snapshots then allows destructive commands when the worktree is dirty', () => {
    const repo = initRepo(tmpDir());
    assert.equal(guard('git reset --hard', repo).stderr, '');
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    const run = guard('git reset --hard', repo);
    assert.equal(run.status, 0);
    assert.match(run.stderr, /saved a recovery snapshot as refs\/h7\/backup\/\d{8}T\d{6}Z-001/);
    const drop = guard('git -C . stash drop', repo);
    assert.equal(drop.status, 0);
    assert.match(drop.stdout, /git-stash-drop/);
    assert.equal(guard('git status', repo).status, 0);
  });

  it('the snapshot holds tracked edits and untracked files, leaves worktree and index alone, and restores', () => {
    const repo = initRepo(tmpDir());
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    writeFileSync(join(repo, '.gitignore'), 'skip.log\n');
    writeFileSync(join(repo, 'skip.log'), 'ignored\n');
    const before = git(repo, 'status', '--porcelain', '--ignored');
    const run = guard('git reset --hard', repo);
    assert.equal(run.status, 0);
    const ref = /(refs\/h7\/backup\/\S+)/.exec(run.stderr)?.[1] as string;
    assert.ok(run.stderr.includes(`git restore --source=${ref} --worktree -- .`));
    assert.equal(git(repo, 'status', '--porcelain', '--ignored'), before);
    assert.equal(git(repo, 'show', `${ref}:README.md`), 'edited\n');
    assert.equal(git(repo, 'show', `${ref}:new.txt`), 'untracked\n');
    assert.throws(() => git(repo, 'show', `${ref}:skip.log`));
    assert.match(git(repo, 'log', '-1', '--format=%s', ref), /^h7 backup before: git reset --hard/);
    assert.equal(git(repo, 'rev-parse', `${ref}^`), git(repo, 'rev-parse', 'HEAD'));
    assert.deepEqual(logLines(run.home).map((l) => [l.decision, l.rule, l.ref]), [['allow', 'destructive-git-snapshot', ref]]);
    git(repo, 'reset', '--hard', '-q');
    rmSync(join(repo, 'new.txt'));
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# fixture\n');
    git(repo, 'restore', `--source=${ref}`, '--worktree', '--', '.');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'edited\n');
    assert.equal(readFileSync(join(repo, 'new.txt'), 'utf8'), 'untracked\n');
  });

  it('keeps the block when the snapshot cannot be taken (no commit yet)', () => {
    const repo = tmpDir();
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', 'a.txt');
    writeFileSync(join(repo, 'a.txt'), 'y\n');
    assert.equal(decision(guard('git reset --hard', repo)), 'block');
  });

  it('blocks committing staged secrets and allows examples', () => {
    const repo = initRepo(tmpDir());
    writeFileSync(join(repo, '.env'), 'TOKEN=1\n');
    writeFileSync(join(repo, '.env.example'), 'TOKEN=\n');
    git(repo, 'add', '-f', '.env', '.env.example');
    const run = guard('git commit -m "add config"', repo);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /secrets-commit.*\.env/);
    git(repo, 'rm', '-q', '--cached', '.env');
    assert.equal(guard('git commit -m "add example"', repo).status, 0);
  });

  it('blocks git add of untracked secrets via broad adds but ignores gitignored ones', () => {
    const repo = initRepo(tmpDir());
    writeFileSync(join(repo, 'server.key'), 'k\n');
    assert.equal(guard('git add .', repo).status, 2);
    writeFileSync(join(repo, '.gitignore'), '*.key\n');
    assert.equal(guard('git add .', repo).status, 0);
    assert.equal(guard('git add server.key', repo).status, 2);
  });

  it('confines recursive deletes to the repository root', () => {
    const repo = initRepo(tmpDir());
    assert.equal(guard('rm -rf node_modules dist', repo).status, 0);
    assert.equal(guard('rm -rf .', repo).status, 2);
    assert.equal(guard('cd .. && rm -rf x', repo).status, 2);
    assert.equal(guard(`rm -rf ${join(repo, '..')}`, repo).status, 2);
    assert.equal(guard('rm -rf ~', repo).status, 2);
    assert.equal(guard('bash -c "rm -rf /"', repo).status, 2);
  });

  it('resolves symlinks before comparing paths', () => {
    const repo = initRepo(tmpDir());
    const outside = tmpDir();
    writeFileSync(join(outside, 'f'), '');
    symlinkSync(outside, join(repo, 'link'), 'junction');
    assert.equal(guard('rm -rf link/f', repo).status, 2);
    assert.equal(guard('rm -rf link', repo).status, 2);
  });

  it('works for the PowerShell tool', () => {
    const repo = initRepo(tmpDir());
    assert.equal(guard('Remove-Item -Recurse -Force C:\\Windows\\Temp\\x', repo, { tool: 'PowerShell' }).status, process.platform === 'win32' ? 2 : 0);
    assert.equal(guard('git push --force origin main', repo, { tool: 'PowerShell' }).status, 2);
    assert.equal(guard('Get-ChildItem', repo, { tool: 'PowerShell' }).status, 0);
  });

  it('H7_GUARD=off disables it and logs once', () => {
    const repo = initRepo(tmpDir());
    const home = tmpDir('h7-home-');
    const env = { H7_GUARD: 'off' };
    assert.equal(guard('git push -f origin main', repo, { home, env }).status, 0);
    assert.equal(guard('git push -f origin main', repo, { home, env }).status, 0);
    assert.equal(logLines(home).length, 1);
    assert.equal(logLines(home)[0]?.decision, 'disabled');
  });

  it('asks on garbage input and writes an error log line', () => {
    const home = tmpDir('h7-home-');
    const result = runNode(script, [], { input: 'garbage', env: { H7_HOME: home } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /internal error/);
    assert.equal(logLines(home)[0]?.decision, 'error');
  });

  it('survives an empty stdin and a nonexistent cwd', () => {
    const home = tmpDir('h7-home-');
    assert.equal(runNode(script, [], { input: '', env: { H7_HOME: home } }).status, 0);
    const run = guard('git push -f origin main', join(tmpDir(), 'missing'));
    assert.equal(run.status, 2);
  });

  it('uses os.homedir when H7_HOME is unset', () => {
    const home = tmpDir('h7-home-');
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push -f origin main' }, cwd: home });
    const result = runNode(script, [], { input, env: { H7_HOME: undefined, HOME: home, USERPROFILE: home } });
    assert.equal(result.status, 2);
    assert.equal(logLines(home)[0]?.rule, 'force-push-protected');
  });

  it('git failures inside a repository ask instead of reporting clean', () => {
    const repo = initRepo(tmpDir());
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'a');
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    assert.equal(decision(guard('git reset --hard', repo)), 'allow');
    writeFileSync(join(repo, '.git', 'index'), 'garbage');
    assert.equal(decision(guard('git reset --hard', repo)), 'ask');
    assert.equal(decision(guard('git commit -m x', repo)), 'ask');
  });

  it('untracked files are snapshotted before git clean, but git clean -x (ignored files) still blocks', () => {
    const repo = initRepo(tmpDir());
    writeFileSync(join(repo, 'new.log'), 'x\n');
    assert.equal(decision(guard('git reset --hard', repo)), 'allow');
    assert.equal(decision(guard('git checkout .', repo)), 'allow');
    assert.equal(decision(guard('git clean -fd', repo)), 'allow');
    assert.equal(decision(guard('git clean -fdx', repo)), 'block');
    assert.equal(decision(guard('git stash push -u && git clean -fd', repo)), 'allow');
  });

  it('git checkout of paths on a modified tree is snapshotted, branch switches need nothing', () => {
    const repo = initRepo(tmpDir());
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    git(repo, 'branch', 'other');
    assert.equal(decision(guard('git checkout README.md', repo)), 'allow');
    assert.equal(decision(guard('git checkout HEAD README.md', repo)), 'allow');
    assert.equal(decision(guard('git checkout other', repo)), 'allow');
  });

  it('secret pathspecs are matched from a subdirectory, globs and ignored files included', () => {
    const repo = initRepo(tmpDir());
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, '.env'), 'T=1\n');
    writeFileSync(join(repo, 'sub', '.env'), 'T=1\n');
    writeFileSync(join(repo, 'sub', 'notes.txt'), 'x\n');
    const sub = join(repo, 'sub');
    for (const command of ['git add ../.env', 'git add .env', 'git add :/.env', "git add '.e*'", "git add '../.e*'", 'git add -A', 'git add :/', 'git add .']) {
      assert.equal(decision(guard(command, sub)), 'block', command);
    }
    assert.equal(decision(guard('git add notes.txt', sub)), 'allow');
    git(repo, 'rm', '-q', '--cached', '-r', '.', '--ignore-unmatch');
    writeFileSync(join(repo, '.gitignore'), ['.env', 'sub/.env', ''].join(String.fromCharCode(10)));
    assert.equal(decision(guard('git add -f .', repo)), 'block');
    assert.equal(decision(guard('git add .', repo)), 'allow');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore');
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    assert.equal(decision(guard('git commit -a -m x', sub)), 'allow');
  });
});
