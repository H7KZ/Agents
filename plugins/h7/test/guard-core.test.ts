import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runGuard, type GuardIo } from '../scripts/guard-core.ts';
import type { Runner } from '../scripts/git.ts';
import { logPath } from '../scripts/log.ts';
import { cleanupTmp, tmpDir, writeTree } from '../../../scripts/test/helpers.ts';

cleanupTmp();

const runner: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '/repo\n' } : { status: 128, stdout: '' });

function io(over: Partial<GuardIo> & { command?: string; tool?: string; cwd?: unknown; home?: string } = {}): GuardIo & { home: string } {
  const home = over.home ?? tmpDir();
  const payload = { tool_name: over.tool ?? 'Bash', tool_input: { command: over.command ?? 'ls' }, cwd: over.cwd ?? '/repo' };
  return {
    stdin: JSON.stringify(payload),
    env: { H7_HOME: home },
    platform: 'posix',
    runner,
    realpath: (p) => p,
    homedir: '/nonexistent-home',
    fallbackCwd: '/fallback',
    now: () => new Date('2026-02-03T04:05:06.000Z'),
    ...over,
    home,
  };
}

const log = (home: string): Record<string, unknown>[] => readFileSync(logPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('runGuard decisions', () => {
  it('allows ordinary commands silently without writing a log', () => {
    const setup = io({ command: 'npm test && git status' });
    assert.deepEqual(runGuard(setup), { code: 0, stdout: '', stderr: '' });
    assert.throws(() => readFileSync(logPath(setup.home)));
  });

  it('blocks with exit 2, a rule-named stderr reason, and a log line', () => {
    const setup = io({ command: 'git push --force origin main' });
    const result = runGuard(setup);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^h7 guard blocked \[force-push-protected\]: .*feature branch.*\n$/);
    assert.deepEqual(log(setup.home), [
      { ts: '2026-02-03T04:05:06.000Z', decision: 'block', rule: 'force-push-protected', command: 'git push --force origin main', cwd: '/repo' },
    ]);
  });

  it('asks with the documented hookSpecificOutput JSON and exit 0', () => {
    const setup = io({ command: 'npm publish' });
    const result = runGuard(setup);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, string> };
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'ask');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason as string, /npm publish/);
    assert.equal(log(setup.home)[0]?.decision, 'ask');
    assert.ok(result.stdout.endsWith('\n'));
  });

  it('truncates the logged command to 500 characters', () => {
    const setup = io({ command: `git push --force origin main # ${'x'.repeat(600)}` });
    runGuard(setup);
    assert.equal((log(setup.home)[0] as { command: string }).command.length, 500);
  });

  it('uses PowerShell syntax for the PowerShell tool', () => {
    const setup = io({ tool: 'PowerShell', command: "git commit -m @'\nrm -rf /\n'@ --no-verify", platform: 'posix' });
    assert.equal(runGuard(setup).code, 2);
    assert.equal(runGuard(io({ tool: 'PowerShell', command: "git commit -m @'\nrm -rf /\n'@" })).code, 0);
  });

  it('ignores other tools, empty commands and missing fields', () => {
    assert.equal(runGuard(io({ tool: 'Edit', command: 'git push -f origin main' })).code, 0);
    assert.equal(runGuard(io({ command: '   ' })).code, 0);
    assert.equal(runGuard(io({ stdin: '{"tool_name":"Bash"}' })).code, 0);
    assert.equal(runGuard(io({ stdin: '{"tool_name":"Bash","tool_input":{"command":5}}' })).code, 0);
    assert.equal(runGuard(io({ stdin: '{"tool_input":{"command":"git push -f origin main"}}' })).code, 0);
  });

  it('falls back to the process cwd when the hook input has none', () => {
    const noCwd = io({ stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push -f origin main' } }) });
    runGuard(noCwd);
    assert.equal(log(noCwd.home)[0]?.cwd, '/fallback');
    const emptyCwd = io({ command: 'git push -f origin main', cwd: '' });
    runGuard(emptyCwd);
    assert.equal(log(emptyCwd.home)[0]?.cwd, '/fallback');
    const badCwd = io({ command: 'git push -f origin main', cwd: 5 });
    runGuard(badCwd);
    assert.equal(log(badCwd.home)[0]?.cwd, '/fallback');
  });

  it('uses the injected home dir unless H7_HOME overrides it', () => {
    const real = tmpDir();
    const setup = io({ command: 'git push -f origin main', homedir: real, env: {} });
    runGuard(setup);
    assert.equal(log(real).length, 1);
    const home = tmpDir();
    runGuard(io({ command: 'git push -f origin main', homedir: real, env: { H7_HOME: home } }));
    assert.equal(log(home).length, 1);
    assert.equal(log(real).length, 1);
  });

  it('reports a failing log write without changing the decision', () => {
    const home = tmpDir();
    writeTree(home, { '.h7': 'a file' });
    const block = runGuard(io({ home, command: 'git push -f origin main' }));
    assert.equal(block.code, 2);
    assert.match(block.stderr, /could not write guard log/);
    const ask = runGuard(io({ home, command: 'npm publish' }));
    assert.equal(ask.code, 0);
    assert.match(ask.stderr, /could not write guard log/);
    assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });
});

describe('runGuard kill switch and failure handling', () => {
  it('H7_GUARD=off allows everything and logs the switch once', () => {
    const home = tmpDir();
    const off = (command: string) => io({ home, command, env: { H7_HOME: home, H7_GUARD: 'off' } });
    assert.deepEqual(runGuard(off('git push -f origin main')), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(runGuard(off('rm -rf /')), { code: 0, stdout: '', stderr: '' });
    const entries = log(home);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.decision, 'disabled');
    assert.equal(entries[0]?.rule, 'h7-guard-off');
  });

  it('only the exact value off disables the guard', () => {
    const home = tmpDir();
    const result = runGuard(io({ home, command: 'git push -f origin main', env: { H7_HOME: home, H7_GUARD: 'on' } }));
    assert.equal(result.code, 2);
  });

  it('reports a failing log write for the kill switch', () => {
    const home = tmpDir();
    writeTree(home, { '.h7': 'a file' });
    const result = runGuard(io({ home, env: { H7_HOME: home, H7_GUARD: 'off' } }));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /could not write guard log/);
  });

  it('fails open on malformed input, naming the error on stderr and in the log', () => {
    const setup = io({ stdin: '{not json' });
    const result = runGuard(setup);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^h7 guard internal error, allowing the command \(fail open\): .+\n$/);
    const entry = log(setup.home)[0] as Record<string, unknown>;
    assert.equal(entry.decision, 'error');
    assert.equal(entry.rule, 'internal-error');
    assert.match(entry.error as string, /JSON/);
  });

  it('fails open on internal errors after parsing and records the command', () => {
    const setup = io({ command: 'git reset --hard' });
    const result = runGuard({
      ...setup,
      runner: () => {
        throw new TypeError('runner exploded');
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /runner exploded/);
    const entry = log(setup.home)[0] as Record<string, unknown>;
    assert.equal(entry.command, 'git reset --hard');
    assert.equal(entry.cwd, '/repo');
    assert.equal(entry.error, 'runner exploded');
  });

  it('fails open and still reports when the log cannot be written', () => {
    const home = tmpDir();
    writeTree(home, { '.h7': 'a file' });
    const result = runGuard(io({ home, stdin: 'nope' }));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /internal error.*could not write guard log/);
  });

  it('accepts a JSON null payload as an internal error, not a crash', () => {
    const result = runGuard(io({ stdin: 'null' }));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /fail open/);
  });
});

describe('hooks.json', () => {
  it('registers the guard in exec form for Bash and PowerShell', () => {
    const file = join(import.meta.dirname, '..', 'hooks', 'hooks.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const [entry] = config.hooks.PreToolUse;
    assert.equal(entry.matcher, 'Bash|PowerShell');
    assert.deepEqual(entry.hooks, [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/guard.ts'] }]);
  });
});

describe('runGuard platform selection', () => {
  it('uses Windows path semantics for win32 and POSIX otherwise', () => {
    const winRunner: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: 'C:/work/repo\n' } : { status: 128, stdout: '' });
    const win = io({ command: 'rd /s /q C:\Users', cwd: 'C:\work\repo', platform: 'win32', runner: winRunner });
    assert.equal(runGuard(win).code, 2);
    const posix = io({ command: 'rm -rf /repo/dist', platform: 'linux' });
    assert.equal(runGuard(posix).code, 0);
  });
});
