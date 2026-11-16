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
    const ok = (over: Partial<GuardIo>) => run('{bad', { H7_HOME: home, H7_GUARD_ASK: 'allow' }, { ...baseDeps(home), ...over });
    assert.equal(ok({}).code, 0);
    assert.equal(ok({}).stdout, '');
    assert.equal(run('{bad', { H7_HOME: home, H7_GUARD_ASK: 'deny' }, baseDeps(home)).code, 2);
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
