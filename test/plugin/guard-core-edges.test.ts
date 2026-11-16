import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { askMode, run, type GuardIo, type GuardResult } from '../../plugins/h7/scripts/guard-core.ts';
import type { Runner } from '../../plugins/h7/scripts/git.ts';
import { logPath } from '../../plugins/h7/scripts/log.ts';
import { cleanupTmp, tmpDir, writeTree } from '../../scripts/test/helpers.ts';
import { repoDisk } from './support.ts';

cleanupTmp();

const runner: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: '/repo\n' } : { status: 128, stdout: '' });

interface Setup {
  payload?: unknown;
  stdin?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  over?: Partial<GuardIo>;
}

/** Runs the guard against a throwaway home; `home` is where the log would go. */
function guard(setup: Setup = {}): GuardResult & { home: string } {
  const home = setup.home ?? tmpDir();
  const env = { H7_HOME: home, ...setup.env };
  const stdin = setup.stdin ?? JSON.stringify(setup.payload);
  const deps: GuardIo = {
    stdin,
    env,
    platform: 'posix',
    runner,
    realpath: (p) => p,
    disk: repoDisk,
    homedir: '/nonexistent-home',
    tmpdir: '/nonexistent-tmp',
    fallbackCwd: '/fallback',
    now: () => new Date('2026-02-03T04:05:06.000Z'),
    readConfig: () => null,
    ...setup.over,
  };
  return { ...run(deps.stdin, deps.env, deps), home };
}

const winRunner: Runner = (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: 'C:/work/repo' + String.fromCharCode(10) } : { status: 128, stdout: '' });
const WORK = ['C:', 'work', 'repo'].join(String.fromCharCode(92));
const bash = (command: string, extra: object = {}): unknown => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/repo', ...extra });
const log = (home: string): Record<string, unknown>[] => readFileSync(logPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ALLOWED: GuardResult = { code: 0, stdout: '', stderr: '' };
const plain = (r: GuardResult): GuardResult => ({ code: r.code, stdout: r.stdout, stderr: r.stderr });
const isAsk = (r: GuardResult): boolean => r.code === 0 && r.stdout !== '' && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'ask';

describe('guard-core: askMode values and defaults', () => {
  const none = (): null => null;
  const body = (text: string) => () => text;

  it('every mode string is accepted from env and from the file, nothing else', () => {
    for (const mode of ['prompt', 'allow', 'deny']) {
      assert.equal(askMode({ H7_GUARD_ASK: mode }, '/h', none, true), mode);
      assert.equal(askMode({}, '/h', body(JSON.stringify({ ask: mode })), true), mode);
    }
    for (const bad of ['', 'ALLOW', 'allow ', 'yes', 'bypass']) {
      assert.equal(askMode({ H7_GUARD_ASK: bad }, '/h', none, true), 'prompt', JSON.stringify(bad));
      assert.equal(askMode({}, '/h', body(JSON.stringify({ ask: bad })), true), 'prompt', JSON.stringify(bad));
    }
  });

  it('with nothing configured the session decides: bypassPermissions allows, anything else prompts', () => {
    assert.equal(askMode({}, '/h', none, true), 'allow');
    assert.equal(askMode({}, '/h', none, false), 'prompt');
    assert.equal(askMode({}, '/h', none), 'prompt');
    assert.equal(askMode({}, '/h', body('{}'), true), 'allow');
    assert.equal(askMode({}, '/h', body('{"other":1}'), false), 'prompt');
    assert.equal(askMode({}, '/h', body('{"ask":null}'), true), 'prompt');
  });

  it('a file or env value beats the session mode, and broken files never allow', () => {
    assert.equal(askMode({}, '/h', body('{"ask":"deny"}'), true), 'deny');
    assert.equal(askMode({ H7_GUARD_ASK: 'prompt' }, '/h', body('{"ask":"allow"}'), true), 'prompt');
    assert.equal(askMode({}, '/h', body('{broken'), true), 'prompt');
    assert.equal(askMode({}, '/h', body('﻿{"ask":"allow"}')), 'allow');
  });
});

describe('guard-core: bypassPermissions and the config file', () => {
  it('an unreadable config file counts as unset, so bypass allows asks silently', () => {
    const result = guard({ payload: bash('npm publish', { permission_mode: 'bypassPermissions' }), over: { readConfig: undefined } });
    assert.deepEqual({ code: result.code, stdout: result.stdout }, { code: 0, stdout: '' });
    assert.equal(isAsk(guard({ payload: bash('npm publish'), over: { readConfig: undefined } })), true);
  });

  it('a config file under the home directory is read through the default reader', () => {
    const home = tmpDir();
    writeTree(home, { '.h7/guard.json': '{"ask":"deny"}' });
    const result = guard({ payload: bash('npm publish'), home, over: { readConfig: undefined } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ask mode is deny/);
  });
});

describe('guard-core: ask results with a failing log', () => {
  const failing = (): string => {
    const home = tmpDir();
    writeTree(home, { '.h7': 'a file' });
    return home;
  };

  it('prompt mode keeps the note on stderr, trimmed, one line', () => {
    const r = guard({ payload: bash('npm publish'), home: failing() });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /^\(could not write guard log: .+\)\n$/);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
    assert.ok(r.stdout.endsWith('\n'));
  });

  it('allow mode lets the command through and only reports the log problem', () => {
    const r = guard({ payload: bash('npm publish'), home: failing(), env: { H7_GUARD_ASK: 'allow' } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^\(could not write guard log: .+\)\n$/);
    assert.deepEqual(plain(guard({ payload: bash('npm publish'), env: { H7_GUARD_ASK: 'allow' } })), ALLOWED);
  });

  it('deny mode turns the ask into a block carrying the note', () => {
    const r = guard({ payload: bash('npm publish'), home: failing(), env: { H7_GUARD_ASK: 'deny' } });
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^h7 guard \[[\w-]+\]: .+ \(h7 guard ask mode is deny: find another way or leave it for the user\) \(could not write guard log: .+\)\n$/);
  });

  it('an internal error under an allow or deny config is denied, never allowed', () => {
    for (const mode of ['allow', 'deny']) {
      const r = guard({ stdin: '{broken', env: { H7_GUARD_ASK: mode } });
      assert.equal(r.code, 2, mode);
      assert.match(r.stderr, /^h7 guard internal error: .+ \(h7 guard ask mode is deny/);
    }
    assert.equal(guard({ stdin: '{broken', env: { H7_GUARD_ASK: 'prompt' } }).code, 0);
  });

  it('an internal error reports a failing log write after the reason', () => {
    const r = guard({ stdin: '{broken', home: failing(), env: { H7_GUARD_ASK: 'deny' } });
    assert.match(r.stderr, /\(h7 guard ask mode is deny: find another way or leave it for the user\)h7 guard: could not write guard log: .+\n$/);
    const p = guard({ stdin: '{broken', home: failing() });
    assert.match(p.stderr, /^h7 guard: could not write guard log: .+\n$/);
  });
});

describe('guard-core: guard config protection', () => {
  const CONFIG_REASON = 'h7 guard state in ~/.h7 (ask-mode config, guard log) is owner-only: agents must not change their own guard policy. Ask the user to edit it.';

  it('mentions of the config file or a home .h7 directory in a command are blocked and logged', () => {
    for (const command of ['cat guard.json', 'cat guard".json', "cat guard'.'json", 'cat guard.""json', 'cat GUARD.JSON', 'ls ~/.h7', 'ls $HOME/.h7/x', 'ls C:\\Users\\me\\.h7', 'ls a//.h7', 'ls a/".h7"', "ls a/'.h7", 'ls a\\\\.h7']) {
      const r = guard({ payload: bash(command) });
      assert.equal(r.code, 2, command);
      assert.equal(r.stderr, `h7 guard blocked [guard-config]: ${CONFIG_REASON}\n`, command);
      assert.deepEqual(log(r.home), [{ ts: '2026-02-03T04:05:06.000Z', decision: 'block', rule: 'guard-config', command, cwd: '/fallback' }], command);
    }
  });

  it('repo-relative .h7 paths and look-alike names are fine', () => {
    for (const command of ['ls .h7/x', 'ls ./.h7', 'ls ../.h7', 'ls /.h7', 'cat a/.h7x', 'cat a/.h7.bak', 'cat a/.h7-old', 'echo x=/.h7', 'cat guardrails.json', 'cat guard-json', 'cat guard.js']) {
      assert.deepEqual(plain(guard({ payload: bash(command) })), ALLOWED, command);
    }
  });

  it('the block says when the log could not be written', () => {
    const home = tmpDir();
    writeTree(home, { '.h7': 'a file' });
    const r = guard({ payload: bash('cat guard.json'), home });
    assert.match(r.stderr, new RegExp(`^h7 guard blocked \\[guard-config\\]: ${CONFIG_REASON.replace(/[.()~-]/g, '\\$&')} \\(could not write guard log: .+\\)\\n$`));
    const t = guard({ payload: { tool_name: 'Write', tool_input: { file_path: '/x/guard.json' }, cwd: '/repo' }, home });
    assert.match(t.stderr, / \(could not write guard log: .+\)\n$/);
  });

  it('file tools: the config name or anything inside ~/.h7 is blocked, others pass', () => {
    const home = tmpDir();
    const write = (tool: string, input: object, cwd: unknown = '/repo') => guard({ home, payload: { tool_name: tool, tool_input: input, cwd } });
    const blocked = write('Write', { file_path: '/elsewhere/guard.json' });
    assert.equal(blocked.code, 2);
    assert.deepEqual(log(home), [{ ts: '2026-02-03T04:05:06.000Z', decision: 'block', rule: 'guard-config', command: '/elsewhere/guard.json', cwd: '/fallback' }]);
    for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.equal(write(tool, { file_path: `${home}/.h7/anything.txt` }).code, 2, tool);
    assert.equal(write('NotebookEdit', { notebook_path: `${home}/.h7/n.ipynb` }).code, 2);
    assert.equal(write('NotebookEdit', { notebook_path: '/repo/guard.json' }).code, 2);
    assert.equal(write('NotebookEdit', { notebook_path: '/repo/a.ipynb' }).code, 0);
    assert.equal(write('Write', { file_path: '/repo/a.txt', notebook_path: `${home}/.h7/x` }).code, 0);
    assert.equal(write('Write', { notebook_path: `${home}/.h7/x`, file_path: undefined }).code, 2);
    assert.equal(write('Write', { file_path: '/repo//a.txt' }).code, 0);
    assert.equal(write('Write', { file_path: '/repo/sub//a.txt' }).code, 0);
    assert.equal(write('Write', { file_path: '//server/share/a.txt' }).code, 2);
    assert.equal(write('Write', { file_path: '/repo/a.txt:stream' }).code, 2);
    assert.equal(write('Write', { file_path: 5 }).code, 0);
    assert.equal(write('Write', {}).code, 0);
    assert.equal(write('Read', { file_path: `${home}/.h7/x` }).code, 0);
    assert.equal(write('Bash', { file_path: `${home}/.h7/x` }).code, 0);
  });

  it('a file tool with no input at all is allowed, not an internal error', () => {
    assert.deepEqual(plain(guard({ payload: { tool_name: 'Write', cwd: '/repo' } })), ALLOWED);
    assert.deepEqual(plain(guard({ payload: { tool_name: 'Bash', cwd: '/repo' } })), ALLOWED);
  });

  it('relative targets resolve against the hook cwd, which must be a non-empty string', () => {
    const home = tmpDir();
    const write = (cwd: unknown, fallbackCwd = '/fallback') => guard({ home, payload: { tool_name: 'Write', tool_input: { file_path: '.h7/x.txt' }, cwd }, over: { platform: 'win32', fallbackCwd } });
    assert.equal(write(home).code, 2);
    assert.equal(write('').code, 0);
    assert.equal(write(undefined).code, 0);
    assert.equal(write(5).code, 0);
    assert.equal(write('/repo').code, 0);
    assert.equal(write('', home).code, 2);
    assert.equal(write(undefined, home).code, 2);
  });

  it('windows paths: drive letters are fine, odd path forms and streams are blocked', () => {
    const win = (file: string) => guard({ payload: { tool_name: 'Write', tool_input: { file_path: file }, cwd: 'C:\\work\\repo' }, over: { platform: 'win32', realpath: (p) => p } });
    assert.equal(win('C:\\work\\repo\\a.txt').code, 0);
    assert.equal(win('C:\\work\\repo\\sub\\\\a.txt').code, 0);
    assert.equal(win('\\\\?\\C:\\x').code, 2);
    assert.equal(win('//./pipe/x').code, 2);
    assert.equal(win('C:\\work\\repo\\a.txt:stream').code, 2);
  });
});

describe('guard-core: tool and input handling', () => {
  it('other tools never reach the command scanner', () => {
    assert.deepEqual(plain(guard({ payload: { tool_name: 'Read', tool_input: { command: 'git push -f origin main' }, cwd: '/repo' } })), ALLOWED);
    assert.deepEqual(plain(guard({ payload: { tool_input: { command: 'git push -f origin main' }, cwd: '/repo' } })), ALLOWED);
    assert.equal(guard({ payload: { tool_name: 5, tool_input: { command: 'git push -f origin main' } } }).code, 0);
  });

  it('empty and non-string commands are allowed quietly', () => {
    for (const command of ['', '   ', '\n\t', 5, null, undefined]) {
      const r = guard({ payload: { tool_name: 'Bash', tool_input: { command }, cwd: '/repo' } });
      assert.deepEqual({ code: r.code, stdout: r.stdout, stderr: r.stderr }, ALLOWED, String(command));
    }
  });

  it('the hook cwd is used when it is a non-empty string, else the process cwd, and is logged', () => {
    const cwdOf = (cwd: unknown): unknown => {
      const r = guard({ payload: bash('git push -f origin main', { cwd }) });
      return log(r.home)[0]?.cwd;
    };
    assert.equal(cwdOf('/repo'), '/repo');
    assert.equal(cwdOf(''), '/fallback');
    assert.equal(cwdOf(7), '/fallback');
    assert.equal(cwdOf(undefined), '/fallback');
  });

  it('PowerShell commands use PowerShell syntax, Bash commands do not', () => {
    const tool = (name: string) => guard({ payload: { tool_name: name, tool_input: { command: '$x = 5' }, cwd: '/repo' } });
    assert.deepEqual(plain(tool('PowerShell')), ALLOWED);
    assert.equal(isAsk(tool('Bash')), true);
  });

  it('the logged entry carries the command, rule and decision', () => {
    const r = guard({ payload: bash('npm publish') });
    assert.deepEqual(log(r.home), [{ ts: '2026-02-03T04:05:06.000Z', decision: 'ask', rule: 'deploy-publish', command: 'npm publish', cwd: '/repo' }]);
  });
});

describe('guard-core: kill switch and internal errors', () => {
  it('the kill switch entry records the empty command and the fallback cwd', () => {
    const r = guard({ payload: bash('rm -rf /'), env: { H7_GUARD: 'off' } });
    assert.deepEqual(log(r.home), [{ ts: '2026-02-03T04:05:06.000Z', decision: 'disabled', rule: 'h7-guard-off', command: '', cwd: '/fallback' }]);
    assert.deepEqual({ code: r.code, stdout: r.stdout, stderr: r.stderr }, ALLOWED);
  });

  it('the kill switch says so when its log write fails', () => {
    const home = tmpDir();
    writeTree(home, { '.h7': 'a file' });
    const r = guard({ payload: bash('ls'), home, env: { H7_GUARD: 'off' } });
    assert.match(r.stderr, /^h7 guard: could not write guard log: .+\n$/);
  });

  it('a parse failure logs an empty command and the fallback cwd', () => {
    const r = guard({ stdin: '{broken' });
    const [entry] = log(r.home);
    assert.deepEqual([entry?.decision, entry?.rule, entry?.command, entry?.cwd], ['error', 'internal-error', '', '/fallback']);
    assert.ok(isAsk(r));
  });

  it('an error while scanning logs the command and the hook cwd', () => {
    const boom: Runner = () => {
      throw new Error('kaput');
    };
    const r = guard({ payload: bash('git reset --hard', { cwd: '/repo' }), over: { runner: boom } });
    const [entry] = log(r.home);
    assert.deepEqual([entry?.command, entry?.cwd, entry?.error], ['git reset --hard', '/repo', 'kaput']);
  });
});

describe('guard-core: temporary directories', () => {
  const rm = (command: string, over: Partial<GuardIo> = {}, cwd = '/repo'): GuardResult => {
    const r = guard({ payload: bash(command, { cwd }), over: { disk: { kind: (p) => (p.split(String.fromCharCode(92)).join('/').endsWith(`${cwd}/.git`) ? 'dir' : null), read: () => null }, ...over } });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };

  it('recursive deletes inside the system temp directories are allowed on posix', () => {
    assert.deepEqual(rm('rm -rf /tmp/build'), ALLOWED);
    assert.deepEqual(rm('rm -rf /var/tmp/build'), ALLOWED);
    assert.deepEqual(rm('rm -rf /nonexistent-tmp/build'), ALLOWED);
    assert.equal(rm('rm -rf /elsewhere/build').code, 2);
    assert.equal(rm('rm -rf /tmpx/build').code, 2);
  });

  it('a temp directory that contains the working directory does not whitelist anything', () => {
    assert.equal(rm('rm -rf /work/other', { tmpdir: '/work' }, '/work/repo').code, 2);
    assert.deepEqual(rm('rm -rf /elsewhere/other', { tmpdir: '/elsewhere' }, '/work/repo'), ALLOWED);
  });

  it('a temp directory that contains the home directory does not whitelist anything', () => {
    const home = tmpDir();
    const parent = home.slice(0, Math.max(home.lastIndexOf('/'), home.lastIndexOf(String.fromCharCode(92)))).split(String.fromCharCode(92)).join('/');
    const r = guard({ payload: { tool_name: 'Bash', tool_input: { command: `rm -rf ${parent}/other` }, cwd: WORK }, home, over: { platform: 'win32', tmpdir: parent, runner: winRunner } });
    assert.equal(r.code, 2);
    const ok = guard({ payload: { tool_name: 'Bash', tool_input: { command: `rm -rf ${parent}/other/x` }, cwd: WORK }, home, over: { platform: 'win32', tmpdir: `${parent}/other`, runner: winRunner } });
    assert.equal(ok.code, 0);
  });

  it('on windows only the reported temp directory counts, not the posix ones', () => {
    const win = (command: string) => {
      const r = guard({ payload: { tool_name: 'Bash', tool_input: { command }, cwd: 'C:\\work\\repo' }, over: { platform: 'win32', tmpdir: 'C:\\Temp', runner: (args) => (args[0] === 'rev-parse' ? { status: 0, stdout: 'C:/work/repo\n' } : { status: 128, stdout: '' }) } });
      return r.code;
    };
    assert.equal(win('rd /s /q C:\\tmp\\x'), 2);
    assert.equal(win('rd /s /q C:\\var\\tmp\\x'), 2);
    assert.equal(win('rd /s /q C:\\Temp\\x'), 0);
  });
});
