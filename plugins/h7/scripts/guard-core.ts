import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createGit, spawnRunner, type Runner } from './git.ts';
import { realDisk, type Disk } from './gitfiles.ts';
import { appendDisabledOnce, appendLog, type LogEntry } from './log.ts';
import { makePaths, type Realpath } from './paths.ts';
import { pickDecision, scan } from './scan.ts';
import { newState, type Ctx, type Decision } from './types.ts';

export interface Deps {
  /** Filesystem view; defaults to the real disk. */
  disk?: Disk;
  platform: string;
  runner: Runner;
  realpath: Realpath;
  homedir: string;
  tmpdir: string;
  fallbackCwd: string;
  now: () => Date;
  /** Reads <home>/.h7/guard.json; returns null when absent. Defaults to the real file. */
  readConfig?: (home: string) => string | null;
}

/** What an ASK decision becomes: a prompt (default), silently allowed, or turned into a block. */
export type AskMode = 'prompt' | 'allow' | 'deny';

const ASK_MODES: readonly string[] = ['prompt', 'allow', 'deny'];

function readGuardConfig(home: string): string | null {
  try {
    return readFileSync(join(home, '.h7', 'guard.json'), 'utf8');
  } catch {
    return null;
  }
}

/** H7_GUARD_ASK wins over ~/.h7/guard.json {"ask": ...}; anything unknown or unreadable means prompt. */
export function askMode(env: Record<string, string | undefined>, home: string, read: (home: string) => string | null): AskMode {
  const fromEnv = env.H7_GUARD_ASK;
  if (fromEnv !== undefined) return ASK_MODES.includes(fromEnv) ? (fromEnv as AskMode) : 'prompt';
  const text = read(home);
  if (text === null) return 'prompt';
  try {
    const value = (JSON.parse(text.replace(/^﻿/, '')) as { ask?: unknown }).ask;
    return typeof value === 'string' && ASK_MODES.includes(value) ? (value as AskMode) : 'prompt';
  } catch {
    return 'prompt';
  }
}

/** Everything the guard needs, as one object (used by tests that build whole inputs). */
export interface GuardIo extends Deps {
  stdin: string;
  env: Record<string, string | undefined>;
}

export interface GuardResult {
  code: 0 | 2;
  stdout: string;
  stderr: string;
}

const ALLOW: GuardResult = { code: 0, stdout: '', stderr: '' };

interface HookInput {
  tool_name?: unknown;
  tool_input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown };
  cwd?: unknown;
}

function askResult(reason: string, note: string, mode: AskMode): GuardResult {
  if (mode === 'allow') return { code: 0, stdout: '', stderr: note === '' ? '' : `${note.trim()}
` };
  if (mode === 'deny') {
    return { code: 2, stdout: '', stderr: `${reason} (h7 guard ask mode is deny: find another way or leave it for the user)${note}
` };
  }
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
  return { code: 0, stdout: `${JSON.stringify(output)}
`, stderr: note === '' ? '' : `${note.trim()}
` };
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Any mention of the config file name, or a .h7 path segment reached through another directory
// (~/.h7, $HOME/.h7, $X/.h7, C:\Users\me\.h7). A repo-relative ".h7/..." or "./.h7/..." is not matched.
const CONFIG_MENTION = /guard["']*\.["']*json|[^\s"'=:.\\/][\\/]+["']*\.h7(?![\w.-])/i;
// The config name anywhere in the target, plus Windows path forms the containment check cannot
// canonicalise (\\?\, \\.\, UNC shares, NTFS streams after the drive letter): fail closed on those.
const CONFIG_NAME = /guard\.json|^[\\/]{2}|^.{2,}:/i;
const CONFIG_REASON =
  'h7 guard state in ~/.h7 (ask-mode config, guard log) is owner-only: agents must not change their own guard policy. Ask the user to edit it.';

function configBlock(note = ''): GuardResult {
  return { code: 2, stdout: '', stderr: `h7 guard blocked [guard-config]: ${CONFIG_REASON}${note}
` };
}

function respond(decision: Decision, logError: string | null, mode: AskMode): GuardResult {
  const note = logError === null ? '' : ` (could not write guard log: ${logError})`;
  if (decision.decision === 'block') {
    return { code: 2, stdout: '', stderr: `h7 guard blocked [${decision.rule}]: ${decision.reason}${note}
` };
  }
  return askResult(`h7 guard [${decision.rule}]: ${decision.reason}`, note, mode);
}

export function run(stdinText: string, env: Record<string, string | undefined>, io: Deps): GuardResult {
  const home = env.H7_HOME ?? io.homedir;
  const entry = (decision: LogEntry['decision'], rule: string, command: string, cwd: string): LogEntry => ({
    ts: io.now().toISOString(),
    decision,
    rule,
    command,
    cwd,
  });
  const mode = askMode(env, home, io.readConfig ?? readGuardConfig);
  let cwd = io.fallbackCwd;
  let command = '';
  try {
    if (env.H7_GUARD === 'off') {
      const logError = appendDisabledOnce(home, entry('disabled', 'h7-guard-off', '', cwd));
      return { ...ALLOW, stderr: logError === null ? '' : `h7 guard: could not write guard log: ${logError}\n` };
    }
    const input = JSON.parse(stdinText) as HookInput;
    if (typeof input.tool_name === 'string' && FILE_TOOLS.has(input.tool_name)) {
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== 'string') return ALLOW;
      const paths = makePaths(io.platform === 'win32' ? 'win32' : 'posix', io.realpath);
      const base = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : io.fallbackCwd;
      const dir = paths.resolve(paths.resolve(base, home), '.h7');
      if (!paths.isInside(dir, paths.resolve(base, target)) && !CONFIG_NAME.test(target)) return ALLOW;
      const logError = appendLog(home, entry('block', 'guard-config', target, cwd));
      return configBlock(logError === null ? '' : ` (could not write guard log: ${logError})`);
    }
    const text = input.tool_input?.command;
    if ((input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') || typeof text !== 'string' || text.trim() === '') {
      return ALLOW;
    }
    command = text;
    if (CONFIG_MENTION.test(text)) {
      const logError = appendLog(home, entry('block', 'guard-config', text, cwd));
      return configBlock(logError === null ? '' : ` (could not write guard log: ${logError})`);
    }
    cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : io.fallbackCwd;
    const platform = io.platform === 'win32' ? 'win32' : 'posix';
    const paths = makePaths(platform, io.realpath);
    const disk = io.disk ?? realDisk;
    const posixTemp = platform === 'posix' ? ['/tmp', '/var/tmp'] : [];
    const candidates = [...new Set([io.tmpdir, ...posixTemp].map((dir) => paths.resolve(cwd, dir)))];
    // A temp dir that contains the working directory or the home directory must not whitelist them.
    const dirs = candidates.filter((dir) => !paths.isInside(dir, cwd) && !paths.isInside(dir, paths.resolve(cwd, home)));
    const ctx: Ctx = { cwd, home, paths, git: createGit(io.runner, disk), disk, taint: { home: false }, tmp: { dirs } };
    const decision = pickDecision(scan(command, input.tool_name === 'PowerShell' ? 'ps' : 'sh', ctx, newState(cwd)));
    if (decision === null) return ALLOW;
    return respond(decision, appendLog(home, entry(decision.decision, decision.rule, command, cwd)), mode);
  } catch (error) {
    const message = (error as Error).message;
    const logError = appendLog(home, { ...entry('error', 'internal-error', command, cwd), error: message });
    return askResult(`h7 guard internal error: ${message}`, logError === null ? '' : `h7 guard: could not write guard log: ${logError}`, mode === 'prompt' ? 'prompt' : 'deny');
  }
}

export function defaultDeps(): Deps {
  return {
    platform: process.platform,
    runner: spawnRunner,
    realpath: realpathSync.native,
    homedir: homedir(),
    tmpdir: tmpdir(),
    fallbackCwd: process.cwd(),
    now: () => new Date(),
  };
}

export async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
