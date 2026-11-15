import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanupTmp, git, initRepo, runNode, tmpDir } from '../../../scripts/test/helpers.ts';

cleanupTmp();

const script = join(import.meta.dirname, '..', 'scripts', 'guard.ts');

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

  it('blocks destructive commands only when the worktree is dirty', () => {
    const repo = initRepo(tmpDir());
    assert.equal(guard('git reset --hard', repo).status, 0);
    writeFileSync(join(repo, 'README.md'), 'edited\n');
    const run = guard('git reset --hard', repo);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /destructive-git-dirty/);
    assert.equal(guard('git -C . stash drop', repo).status, 2);
    assert.equal(guard('git status', repo).status, 0);
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
    writeFileSync(join(repo, 'server.pem'), 'k\n');
    assert.equal(guard('git add .', repo).status, 2);
    writeFileSync(join(repo, '.gitignore'), '*.pem\n');
    assert.equal(guard('git add .', repo).status, 0);
    assert.equal(guard('git add server.pem', repo).status, 2);
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

  it('fails open on garbage input with a stderr note and an error log line', () => {
    const home = tmpDir('h7-home-');
    const result = runNode(script, [], { input: 'garbage', env: { H7_HOME: home } });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /fail open/);
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
});
