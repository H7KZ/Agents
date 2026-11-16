import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createGit, snapshotRunner, spawnRunner, type Runner } from './git.ts';
import { realDisk, type Disk } from './gitfiles.ts';
import { appendDisabledOnce, appendLog, type LogEntry } from './log.ts';
import { makePaths, type Realpath } from './paths.ts';
import { withScratch } from './workspace.ts';
import { pickDecision, scan } from './scan.ts';
import { takeSnapshot } from './snapshot.ts';
import { newState, IGNORED_LOSS, type Ctx, type Decision } from './types.ts';
import { isUnattended, realProbe, type Probe } from './unattended.ts';

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
  /** Disk view for the unattended check; defaults to the real disk. */
  probe?: Probe;
  /** Runner for the recovery snapshot (longer timeout); defaults to `runner`. */
  snapshotRunner?: Runner;
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

/**
 * H7_GUARD_ASK wins over ~/.h7/guard.json {"ask": ...}; an unknown value or an unreadable file means prompt.
 * With nothing configured the guard follows the session: allow under bypassPermissions (the user already chose to
 * trust the agent, so the guard does not add its own prompts), else prompt. Hard blocks never change.
 */
export function askMode(env: Record<string, string | undefined>, home: string, read: (home: string) => string | null, bypass = false): AskMode {
  const unset: AskMode = bypass ? 'allow' : 'prompt';
  const fromEnv = env.H7_GUARD_ASK;
  if (fromEnv !== undefined) return ASK_MODES.includes(fromEnv) ? (fromEnv as AskMode) : 'prompt';
  const text = read(home);
  if (text === null) return unset;
  try {
    const value = (JSON.parse(text.replace(/^﻿/, '')) as { ask?: unknown }).ask;
    if (value === undefined) return unset;
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
  permission_mode?: unknown;
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

/** An ask in an unattended run: nobody is there to answer, so it is refused at once and the agent parks it. */
function unattendedResult(reason: string, note: string): GuardResult {
  return { code: 2, stdout: '', stderr: `${reason} (unattended run: this needs a human; park it, record it in the journal with run-journal.ts park, continue with other work)${note}
` };
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Any mention of the config file name, or a .h7 path segment reached through another directory
// (~/.h7, $HOME/.h7, $X/.h7, C:\Users\me\.h7). A repo-relative ".h7/..." or "./.h7/..." is not matched.
const CONFIG_MENTION = /guard["']*\.["']*json|[^\s"'=:.\\/][\\/]+["']*\.h7(?![\w.-])/i;
// The config name anywhere in the target, plus Windows path forms the containment check cannot
// canonicalise (\\?\, \\.\, UNC shares, NTFS streams after the drive letter): fail closed on those.
const CONFIG_NAME = /guard\.json|^[\\/]{2}|^.{2,}:/i;
const RUNS_PATH = /[\\/]\.h7[\\/]runs(?:[\\/]|$)/i;
const RUNS_MENTION = /\.h7[\\/]+["']?runs(?![\w.-])/i;
// Anything that can change a file; a mere read (ls, cat, Get-Content) of the journal stays allowed.
const WRITE_WORDS = />|\b(?:tee|rm|rmdir|mv|cp|ln|sed|awk|perl|python3?|node|truncate|dd|install|del|erase|ren|rename|touch|chmod|set-content|add-content|out-file|clear-content|remove-item|move-item|copy-item|new-item|rename-item|sc|ac|ri|mi|ci|ni)\b/i;
// The workspace marker is guard policy too (its scratch list widens what deletes may touch): any spelling of its name, quoted, globbed or as an
// 8.3 short name. Shell commands are refused only together with a write-ish word or redirect, so reading it stays possible.
const MARKER_NAME = /h7["']*-["']*(?:w["']*o["']*r["']*k|[*?[])|h7-wor~\d/i;
const MARKER_REASON =
  'The h7 workspace marker (.h7-workspace.json) is guard policy: its scratch list widens what deletes may touch and it sets ship defaults. Agents must not change it. Ask the user to edit it.';
const CONFIG_REASON =
  'h7 guard state in ~/.h7 (ask-mode config, guard log) is owner-only: agents must not change their own guard policy. Ask the user to edit it.';

function markerBlock(note = ''): GuardResult {
  return { code: 2, stdout: '', stderr: `h7 guard blocked [workspace-marker]: ${MARKER_REASON}${note}\n` };
}

function configBlock(note = ''): GuardResult {
  return { code: 2, stdout: '', stderr: `h7 guard blocked [guard-config]: ${CONFIG_REASON}${note}
` };
}

/** The journal of an unattended run is what keeps the guard strict: only run-journal.ts writes it. */
function journalBlock(logError: string | null): GuardResult {
  const note = logError === null ? '' : ` (could not write guard log: ${logError})`;
  return { code: 2, stdout: '', stderr: `h7 guard blocked [unattended-journal]: the run journal of an unattended run is written only by run-journal.ts${note}\n` };
}

function respond(decision: Decision, logError: string | null, mode: AskMode, unattended: () => boolean): GuardResult {
  const note = logError === null ? '' : ` (could not write guard log: ${logError})`;
  if (decision.decision === 'block') {
    return { code: 2, stdout: '', stderr: `h7 guard blocked [${decision.rule}]: ${decision.reason}${note}
` };
  }
  const reason = `h7 guard [${decision.rule}]: ${decision.reason}`;
  // Stricter only: an unattended run turns a prompt into a refusal; allow, deny and bypass-derived allow are never touched.
  return mode === 'prompt' && unattended() ? unattendedResult(reason, note) : askResult(reason, note, mode);
}

const DIRTY_RULE = 'destructive-git-dirty';

/**
 * Recovery snapshots when every block in the scan is a dirty-tree destructive git command whose loss a snapshot can hold: one per distinct
 * target repository (each call carries the directory it acts in, -C and cd included). Null (keep the block) when anything else blocks, ignored
 * files are at stake, any target is unknown or not a repository, or any snapshot step fails.
 */
function snapshotsFor(found: Decision[], command: string, ctx: Ctx, io: Deps): string[] | null {
  const blocks = found.filter((d) => d.decision === 'block');
  if (blocks.length === 0 || blocks.some((d) => d.rule !== DIRTY_RULE || d.reason.includes(IGNORED_LOSS))) return null;
  const roots = blocks.map((d) => (d.dir === undefined ? null : ctx.git.repoRoot(d.dir)));
  if (roots.some((root) => root === null)) return null;
  const refs: string[] = [];
  for (const root of new Set(roots as string[])) {
    const result = takeSnapshot(root, command, { runner: io.snapshotRunner ?? io.runner, now: io.now });
    if (!result.ok) return null;
    refs.push(result.ref);
  }
  return refs;
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
  const configured = askMode(env, home, io.readConfig ?? readGuardConfig);
  let mode = configured;
  let cwd = io.fallbackCwd;
  let command = '';
  const probe = io.probe ?? realProbe;
  const unattended = (): boolean => isUnattended(env, cwd, probe);
  try {
    if (env.H7_GUARD === 'off') {
      const logError = appendDisabledOnce(home, entry('disabled', 'h7-guard-off', '', cwd));
      return { ...ALLOW, stderr: logError === null ? '' : `h7 guard: could not write guard log: ${logError}\n` };
    }
    const input = JSON.parse(stdinText) as HookInput;
    mode = askMode(env, home, io.readConfig ?? readGuardConfig, input.permission_mode === 'bypassPermissions');
    if (typeof input.tool_name === 'string' && FILE_TOOLS.has(input.tool_name)) {
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (typeof target !== 'string') return ALLOW;
      const paths = makePaths(io.platform === 'win32' ? 'win32' : 'posix', io.realpath);
      const base = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : io.fallbackCwd;
      const dir = paths.resolve(paths.resolve(base, home), '.h7');
      const resolved = paths.resolve(base, target);
      if (MARKER_NAME.test(target) || MARKER_NAME.test(resolved)) {
        const logError = appendLog(home, entry('block', 'workspace-marker', target, base));
        return markerBlock(logError === null ? '' : ` (could not write guard log: ${logError})`);
      }
      if (!paths.isInside(dir, resolved) && !CONFIG_NAME.test(target)) {
        if (!RUNS_PATH.test(resolved) || !isUnattended(env, base, probe)) return ALLOW;
        return journalBlock(appendLog(home, entry('block', 'unattended-journal', target, base)));
      }
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
    if (MARKER_NAME.test(text) && WRITE_WORDS.test(text)) {
      const logError = appendLog(home, entry('block', 'workspace-marker', text, cwd));
      return markerBlock(logError === null ? '' : ` (could not write guard log: ${logError})`);
    }
    if (RUNS_MENTION.test(text) && WRITE_WORDS.test(text) && unattended()) return journalBlock(appendLog(home, entry('block', 'unattended-journal', text, cwd)));
    const platform = io.platform === 'win32' ? 'win32' : 'posix';
    const paths = makePaths(platform, io.realpath);
    const disk = io.disk ?? realDisk;
    const posixTemp = platform === 'posix' ? ['/tmp', '/var/tmp'] : [];
    const candidates = [...new Set([io.tmpdir, ...posixTemp].map((dir) => paths.resolve(cwd, dir)))];
    // A temp dir that contains the working directory or the home directory must not whitelist them.
    const dirs = candidates.filter((dir) => !paths.isInside(dir, cwd) && !paths.isInside(dir, paths.resolve(cwd, home)));
    const ctx: Ctx = { cwd, home, paths, git: createGit(io.runner, disk), disk, taint: { home: false }, tmp: withScratch(dirs, cwd, paths.resolve(cwd, home)) };
    const found = scan(command, input.tool_name === 'PowerShell' ? 'ps' : 'sh', ctx, newState(cwd));
    const snapshot = snapshotsFor(found, command, ctx, io);
    // The dirty-tree block is dropped when it was snapshotted, and when a stronger unrelated block names the real reason.
    const otherBlock = found.some((d) => d.decision === 'block' && d.rule !== DIRTY_RULE);
    const decision = pickDecision(snapshot === null && !otherBlock ? found : found.filter((d) => d.rule !== DIRTY_RULE));
    if (snapshot !== null) {
      const logError = appendLog(home, { ...entry('allow', 'destructive-git-snapshot', command, cwd), ref: snapshot.join(',') });
      const note = `h7 guard: saved a recovery snapshot as ${snapshot.join(', ')} before this destructive git command; undo with: ${snapshot.map((ref) => `git restore --source=${ref} --worktree -- .`).join('; ')}${logError === null ? '' : ` (could not write guard log: ${logError})`}`;
      if (decision === null) return { ...ALLOW, stderr: `${note}
` };
      const rest = respond(decision, appendLog(home, entry(decision.decision, decision.rule, command, cwd)), mode, unattended);
      return { ...rest, stderr: `${note}
${rest.stderr}` };
    }
    if (decision === null) return ALLOW;
    return respond(decision, appendLog(home, entry(decision.decision, decision.rule, command, cwd)), mode, unattended);
  } catch (error) {
    const message = (error as Error).message;
    const logError = appendLog(home, { ...entry('error', 'internal-error', command, cwd), error: message });
    const note = logError === null ? '' : `h7 guard: could not write guard log: ${logError}`;
    if (configured === 'prompt' && unattended()) return unattendedResult(`h7 guard internal error: ${message}`, note === '' ? '' : ` (${note})`);
    return askResult(`h7 guard internal error: ${message}`, note, configured === 'prompt' ? 'prompt' : 'deny');
  }
}

export function defaultDeps(): Deps {
  return {
    platform: process.platform,
    runner: spawnRunner,
    snapshotRunner,
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
