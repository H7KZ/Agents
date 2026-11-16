import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createGit, spawnRunner, type Runner } from './git.ts';
import type { Disk } from './gitfiles.ts';
import { appendDisabledOnce, appendLog, type LogEntry } from './log.ts';
import { makePaths, type Realpath } from './paths.ts';
import { pickDecision, scan } from './scan.ts';
import type { Ctx, Decision } from './types.ts';

export interface Deps {
  /** Filesystem view; defaults to the real disk. */
  disk?: Disk;
  platform: string;
  runner: Runner;
  realpath: Realpath;
  homedir: string;
  fallbackCwd: string;
  now: () => Date;
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
  tool_input?: { command?: unknown };
  cwd?: unknown;
}

function askResult(reason: string, note: string): GuardResult {
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
  return { code: 0, stdout: `${JSON.stringify(output)}
`, stderr: note === '' ? '' : `${note.trim()}
` };
}

function respond(decision: Decision, logError: string | null): GuardResult {
  const note = logError === null ? '' : ` (could not write guard log: ${logError})`;
  if (decision.decision === 'block') {
    return { code: 2, stdout: '', stderr: `h7 guard blocked [${decision.rule}]: ${decision.reason}${note}
` };
  }
  return askResult(`h7 guard [${decision.rule}]: ${decision.reason}`, note);
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
  let cwd = io.fallbackCwd;
  let command = '';
  try {
    if (env.H7_GUARD === 'off') {
      const logError = appendDisabledOnce(home, entry('disabled', 'h7-guard-off', '', cwd));
      return { ...ALLOW, stderr: logError === null ? '' : `h7 guard: could not write guard log: ${logError}\n` };
    }
    const input = JSON.parse(stdinText) as HookInput;
    const text = input.tool_input?.command;
    if ((input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') || typeof text !== 'string' || text.trim() === '') {
      return ALLOW;
    }
    command = text;
    cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : io.fallbackCwd;
    const ctx: Ctx = { cwd, home, paths: makePaths(io.platform === 'win32' ? 'win32' : 'posix', io.realpath), git: createGit(io.runner, io.disk) };
    const decision = pickDecision(scan(command, input.tool_name === 'PowerShell' ? 'ps' : 'sh', ctx, { cwd, env: {} }));
    if (decision === null) return ALLOW;
    return respond(decision, appendLog(home, entry(decision.decision, decision.rule, command, cwd)));
  } catch (error) {
    const message = (error as Error).message;
    const logError = appendLog(home, { ...entry('error', 'internal-error', command, cwd), error: message });
    return askResult(`h7 guard internal error: ${message}`, logError === null ? '' : `h7 guard: could not write guard log: ${logError}`);
  }
}

export function defaultDeps(): Deps {
  return {
    platform: process.platform,
    runner: spawnRunner,
    realpath: realpathSync,
    homedir: homedir(),
    fallbackCwd: process.cwd(),
    now: () => new Date(),
  };
}

export async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
