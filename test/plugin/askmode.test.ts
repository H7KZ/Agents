import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { askMode, run, type GuardIo } from '../../plugins/h7/scripts/guard-core.ts';
import type { Runner } from '../../plugins/h7/scripts/git.ts';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';
import { repoDisk } from './support.ts';

cleanupTmp();

const runner: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '/repo\n' } : { status: 128, stdout: '' });

function guard(command: string, env: Record<string, string | undefined>, over: Partial<GuardIo> = {}) {
  const home = env.H7_HOME as string;
  const setup: GuardIo = {
    stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo' }),
    env,
    platform: 'posix',
    runner,
    realpath: (p) => p,
    disk: repoDisk,
    homedir: home,
    tmpdir: '/nonexistent-tmp',
    fallbackCwd: '/fallback',
    now: () => new Date('2026-02-03T04:05:06.000Z'),
    ...over,
  };
  return run(setup.stdin, setup.env, setup);
}

const none = () => null;
const text = (value: string) => () => value;

describe('askMode', () => {
  it('defaults to prompt with no env and no config', () => {
    assert.equal(askMode({}, '/h', none), 'prompt');
  });

  it('reads each known value from the env', () => {
    for (const mode of ['prompt', 'allow', 'deny'] as const) assert.equal(askMode({ H7_GUARD_ASK: mode }, '/h', none), mode);
  });

  it('treats an unknown env value as prompt and lets env win over the file', () => {
    assert.equal(askMode({ H7_GUARD_ASK: 'yes' }, '/h', text('{"ask":"allow"}')), 'prompt');
    assert.equal(askMode({ H7_GUARD_ASK: 'deny' }, '/h', text('{"ask":"allow"}')), 'deny');
  });

  it('reads the config file, tolerating a BOM', () => {
    assert.equal(askMode({}, '/h', text('{"ask":"allow"}')), 'allow');
    assert.equal(askMode({}, '/h', text('﻿{"ask":"deny"}')), 'deny');
  });

  it('falls back to prompt for invalid JSON, missing key, wrong type or unknown value', () => {
    for (const body of ['{nope', '{}', '{"ask":1}', '{"ask":"maybe"}', 'null']) assert.equal(askMode({}, '/h', text(body)), 'prompt');
  });

  it('passes the home directory to the reader', () => {
    let seen = '';
    askMode({}, '/my/home', (home) => {
      seen = home;
      return null;
    });
    assert.equal(seen, '/my/home');
  });
});

describe('run with ask modes', () => {
  it('prompt mode emits the ask JSON', () => {
    const home = tmpDir();
    const result = guard('npm publish', { H7_HOME: home }, { readConfig: none });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });

  it('allow mode turns an ask into a silent allow but keeps blocks', () => {
    const home = tmpDir();
    assert.deepEqual(guard('npm publish', { H7_HOME: home, H7_GUARD_ASK: 'allow' }), { code: 0, stdout: '', stderr: '' });
    assert.equal(guard('git push --force origin main', { H7_HOME: home, H7_GUARD_ASK: 'allow' }).code, 2);
  });

  it('deny mode turns an ask into a block naming the rule', () => {
    const home = tmpDir();
    const result = guard('npm publish', { H7_HOME: home, H7_GUARD_ASK: 'deny' });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^h7 guard \[.+\]: .*ask mode is deny.*\n$/);
  });

  it('applies the mode to internal errors too', () => {
    const home = tmpDir();
    const allowed = run('{bad', { H7_HOME: home, H7_GUARD_ASK: 'allow' }, baseDeps(home));
    assert.equal(allowed.code, 2, 'internal errors never become a silent allow');
    assert.match(allowed.stderr, /internal error/);
    assert.equal(run('{bad', { H7_HOME: home, H7_GUARD_ASK: 'deny' }, baseDeps(home)).code, 2);
    assert.equal(JSON.parse(run('{bad', { H7_HOME: home }, { ...baseDeps(home), readConfig: none }).stdout).hookSpecificOutput.permissionDecision, 'ask');
  });

  it('reports a failed log write in allow and deny modes', () => {
    const home = tmpDir();
    writeTree(home, { '.h7': 'a file' });
    const allowed = guard('npm publish', { H7_HOME: home, H7_GUARD_ASK: 'allow' });
    assert.equal(allowed.code, 0);
    assert.match(allowed.stderr, /could not write guard log/);
    const denied = guard('npm publish', { H7_HOME: home, H7_GUARD_ASK: 'deny' });
    assert.match(denied.stderr, /could not write guard log/);
  });

  it('reads ~/.h7/guard.json from the real disk by default', () => {
    const home = tmpDir();
    writeTree(home, { '.h7/guard.json': '{"ask":"allow"}' });
    assert.deepEqual(guard('npm publish', { H7_HOME: home }), { code: 0, stdout: '', stderr: '' });
  });
});

const CONFIG = ['.h7', 'guard.json'].join('/');

function fileTool(tool: string, input: Record<string, unknown>, home: string) {
  return run(JSON.stringify({ tool_name: tool, tool_input: input, cwd: '/repo' }), { H7_HOME: home }, baseDeps(home));
}

describe('guard config is owner-only', () => {
  it('blocks shell commands that mention the config file, even in allow mode', () => {
    const home = tmpDir();
    for (const command of [
      `echo '{"ask":"allow"}' > ~/${CONFIG}`,
      `cp x "$HOME/${CONFIG}"`,
      `Set-Content $env:USERPROFILE\\.h7\\guard.json 'x'`,
      `rm ~/.h7/"guard.json"`,
    ]) {
      const result = guard(command, { H7_HOME: home, H7_GUARD_ASK: 'allow' });
      assert.equal(result.code, 2, command);
      assert.match(result.stderr, /^h7 guard blocked \[guard-config\]: .*owner-only/);
    }
  });

  it('blocks Write, Edit, MultiEdit and NotebookEdit on the config path', () => {
    const home = tmpDir();
    const config = `${home}/${CONFIG}`;
    for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.equal(fileTool(tool, { file_path: config }, home).code, 2, tool);
    assert.equal(fileTool('NotebookEdit', { notebook_path: config }, home).code, 2);
    assert.equal(fileTool('Write', { file_path: `/elsewhere/${CONFIG}` }, home).code, 2);
  });

  it('matches the config path case-insensitively with either slash on win32 only', () => {
    const win = run(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'c:/users/me/x/../.H7/GUARD.JSON' }, cwd: 'C:\\repo' }),
      { H7_HOME: 'C:\\Users\\Me' },
      { ...baseDeps('C:\\Users\\Me'), platform: 'win32' },
    );
    assert.equal(win.code, 2);
    const exact = run(
      JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'C:/Users/Me/.h7/guard.json' }, cwd: 'C:\\repo' }),
      { H7_HOME: tmpDir() },
      { ...baseDeps('C:\\Users\\Me'), platform: 'win32' },
    );
    assert.equal(exact.code, 2);
  });

  it('allows file tools on other paths and with no path', () => {
    const home = tmpDir();
    assert.deepEqual(fileTool('Write', { file_path: '/repo/src/a.ts' }, home), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(fileTool('Write', { file_path: `${home}/.h7/other.json` }, home), { code: 0, stdout: '', stderr: '' });
    assert.deepEqual(fileTool('Edit', {}, home), { code: 0, stdout: '', stderr: '' });
  });

  it('notes a failed log write on config blocks', () => {
    const home = tmpDir();
    writeTree(home, { '.h7': 'a file' });
    assert.match(guard(`cat ~/${CONFIG}`, { H7_HOME: home }).stderr, /could not write guard log/);
    assert.match(fileTool('Write', { file_path: `${home}/${CONFIG}` }, home).stderr, /could not write guard log/);
  });
});

function baseDeps(home: string) {
  return {
    platform: 'posix',
    runner,
    realpath: (p: string) => p,
    disk: repoDisk,
    homedir: home,
    tmpdir: '/nonexistent-tmp',
    fallbackCwd: '/fallback',
    now: () => new Date('2026-02-03T04:05:06.000Z'),
  };
}
