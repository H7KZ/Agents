import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, lstatSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnRunner } from './git.ts';
import { countProblem, startIsUnattended, isPhase, isRunId, makeEvent, makeRunId, parseJournal, progressOf, provenCount, serializeEvent, STALL_LIMIT, summarize, type Observed } from './run-journal-core.ts';
import { ensureExclude, pathProblem, writeAtomic } from './setup-files.ts';
import { incomplete, parseState } from './verify-state.ts';
import { placeOf, WorkspaceError, type FsIo, type Place } from './workspace.ts';

export interface Stat {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

export interface JournalIo {
  now(): Date;
  lstat(path: string): Stat | null;
  mkdir(path: string): void;
  read(path: string): string | null;
  readdir(path: string): string[];
  /** Why path must not be written under root (a symlink, or resolving outside it), or null. */
  pathProblem(path: string, root: string): string | null;
  /** Replace a whole file: exclusive random temp file, containment under root re-checked right before the rename. Throws on any refusal. */
  write(path: string, text: string, root: string): void;
  /**
   * Append one line in a single O_APPEND write; starts a new line first when the file ends in a torn one. Refuses a line over MAX_LINE_BYTES and a
   * hardlinked file. Known limit: a path can still be swapped for a link between the caller's lstat checks and this open (no O_NOFOLLOW on Windows);
   * h7 guards against accidents, not against a hostile process writing in the same repo.
   */
  append(path: string, line: string): void;
  /** Absolute path of the repository's info/exclude as git reports it (a worktree shares the main one), null when git cannot say. */
  excludePath(root: string): string | null;
}

export const MAX_LINE_BYTES = 65536;

export const realJournalIo: JournalIo = {
  now: () => new Date(),
  lstat(path) {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true });
  },
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  readdir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  pathProblem: (path, root) => pathProblem(path, root),
  write: (path, text, root) => writeAtomic(path, text, root),
  excludePath(root) {
    const result = spawnRunner(['rev-parse', '--git-path', 'info/exclude'], root);
    return result.status === 0 ? resolve(root, result.stdout.trim()) : null;
  },
  append(path, line) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`refusing a journal line over ${MAX_LINE_BYTES} bytes`);
    const fd = openSync(path, 'a+');
    try {
      const { size, nlink } = fstatSync(fd);
      if (nlink > 1) throw new Error('refusing a hardlinked journal file');
      let prefix = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 10) prefix = '\n';
      }
      writeSync(fd, `${prefix}${line}\n`);
    } finally {
      closeSync(fd);
    }
  },
};

export interface Env {
  /** Test seams for the workspace lookup; default to the real file system and home. */
  fs?: FsIo;
  home?: string;
  io: JournalIo;
  out(text: string): void;
  err(text: string): void;
  stdin(): string;
  cwd: string;
}

const USAGE = [
  'usage: run-journal.ts start [--task <text>] [--unattended]',
  '       run-journal.ts append [--run <id>] <phase> <json | ->',
  '       run-journal.ts park [--run <id>] <json | ->',
  '       run-journal.ts progress [--run <id>] [--limit <n>]',
  '       run-journal.ts show [--run <id>] [--tail <n>]',
].join('\n');

export const RUNS_DIR = '.h7/runs';
export const JOURNAL = 'journal.jsonl';
export const CURRENT = 'CURRENT';
export const PROVEN_FILE = '.h7/review/proven.json';

class Failure extends Error {}

/** Nearest ancestor of dir holding a `.git` (directory or file). */
export function findRoot(dir: string, io: Pick<JournalIo, 'lstat'>): string | null {
  let current = dir;
  for (;;) {
    if (io.lstat(join(current, '.git')) !== null) return current;
    const parent = join(current, '..');
    if (parent === current) return null;
    current = parent;
  }
}

function flags(args: string[], allowed: string[]): { values: Record<string, string>; rest: string[] } {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (!allowed.includes(arg) || value === undefined) throw new Failure(`${allowed.includes(arg) ? 'missing value for' : 'unknown option'} ${arg}\n${USAGE}`);
    values[arg] = value;
    i += 1;
  }
  return { values, rest };
}

const positive = (text: string | undefined, fallback: number, name: string): number => {
  if (text === undefined) return fallback;
  if (!/^\d+$/.test(text) || Number(text) < 1) throw new Failure(`${name} must be a positive integer`);
  return Number(text);
};

/** Refuses symlinks (and junctions) on every part of the run path that exists. */
function checkLinks(root: string, parts: string[], io: JournalIo): void {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if (io.lstat(path)?.isSymbolicLink()) throw new Failure(`refusing symlink: ${part} under ${root}`);
  }
}

/** The run `start` recorded in CURRENT; without it only a single run is unambiguous. Never guesses between several. */
function defaultRun(place: Place, io: JournalIo): string {
  checkLinks(place.contain, [...place.parts, 'runs', CURRENT], io);
  const current = (io.read(join(place.state, 'runs', CURRENT)) ?? '').trim();
  if (current !== '') return current;
  const ids = io.readdir(join(place.state, 'runs')).filter(isRunId);
  const [only, ...others] = ids;
  if (only === undefined) throw new Failure('no run found; start one with: run-journal.ts start');
  if (others.length > 0) throw new Failure(`several runs and no ${CURRENT} file: pass --run <id> (${ids.sort().join(', ')})`);
  return only;
}

function pickRun(place: Place, requested: string | undefined, io: JournalIo): string {
  const id = requested ?? defaultRun(place, io);
  if (!isRunId(id)) throw new Failure(`bad run id: ${id}`);
  checkLinks(place.contain, [...place.parts, 'runs', id, JOURNAL], io);
  if (io.lstat(join(place.state, 'runs', id))?.isDirectory() !== true) throw new Failure(`no such run: ${id}`);
  return id;
}

/** Whether the run CURRENT points to was started unattended; false when there is none or anything about it is unreadable. */
function currentIsUnattended(place: Place, io: JournalIo): boolean {
  const id = (io.read(join(place.state, 'runs', CURRENT)) ?? '').trim();
  if (!isRunId(id)) return false;
  const first = (io.read(join(place.state, 'runs', id, JOURNAL)) ?? '').split('\n', 1)[0] as string;
  return startIsUnattended(first);
}

function start(place: Place, args: string[], env: Env): void {
  const requested = args.includes('--unattended');
  const { values } = flags(args.filter((arg) => arg !== '--unattended'), ['--task']);
  const { io } = env;
  checkLinks(place.contain, [...place.parts, 'runs', CURRENT], io);
  // Workspace mode keeps state outside the repo: no exclude file is read or written.
  const exclude = place.workspace ? null : io.excludePath(place.root);
  if (exclude === null && !place.workspace) throw new Failure('cannot locate the git exclude file (is git installed and is this a repository?); nothing written');
  const current = join(place.state, 'runs', CURRENT);
  const problem = io.pathProblem(current, place.contain) ?? (exclude === null ? null : io.pathProblem(exclude, dirname(dirname(exclude))));
  if (problem !== null) throw new Failure(`${problem}; nothing written`);
  if (exclude !== null) {
    const excluded = ensureExclude(io.read(exclude));
    if (excluded.status !== 'unchanged') io.write(exclude, excluded.text, dirname(dirname(exclude)));
  }
  // A new run never drops unattended from the run it replaces: an agent cannot weaken the guard by starting over.
  const unattended = requested || currentIsUnattended(place, io);
  const base = makeRunId(io.now(), values['--task'] ?? '');
  let id = base;
  for (let n = 2; io.lstat(join(place.state, 'runs', id)) !== null; n += 1) id = `${base}-${n}`;
  io.mkdir(join(place.state, 'runs', id));
  io.append(join(place.state, 'runs', id, JOURNAL), serializeEvent(makeEvent('note', { event: 'start', task: values['--task'] ?? '', ...(unattended ? { unattended: true } : {}) }, io.now())));
  io.write(current, `${id}\n`, place.contain);
  const dir = place.workspace ? join(place.state, 'runs', id).split(sep).join('/') : `${RUNS_DIR}/${id}`;
  env.out(JSON.stringify({ id, dir, journal: `${dir}/${JOURNAL}`, exclude, excluded: exclude !== null, unattended }));
}

function append(place: Place, args: string[], env: Env): void {
  const { values, rest } = flags(args, ['--run']);
  const [phase, json, ...extra] = rest;
  if (phase === undefined || json === undefined || extra.length > 0 || !isPhase(phase)) throw new Failure(USAGE);
  let data: unknown;
  try {
    data = JSON.parse(json === '-' ? env.stdin() : json);
  } catch {
    throw new Failure('data is not valid JSON');
  }
  const record = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : { value: data };
  const problem = countProblem(phase, record);
  if (problem !== null) throw new Failure(problem);
  const id = pickRun(place, values['--run'], env.io);
  env.io.append(join(place.state, 'runs', id, JOURNAL), serializeEvent(makeEvent(phase, record, env.io.now())));
  env.out(JSON.stringify({ id, phase }));
}

/** What the verify record and the proven findings on disk say, when they exist. */
function observe(place: Place, io: JournalIo): Observed {
  const unreadable: string[] = [];
  let failing: number | null = null;
  let unresolved: number | null = null;
  const verify = io.read(join(place.state, 'verify.json'));
  if (verify !== null) {
    const state = parseState(verify);
    if (state === null) unreadable.push('.h7/verify.json');
    else failing = incomplete(state).length;
  }
  const proven = io.read(join(place.state, 'review', 'proven.json'));
  if (proven !== null) {
    const count = provenCount(proven);
    if (count === null) unreadable.push(PROVEN_FILE);
    else unresolved = count;
  }
  return { failing, unresolved, unreadable };
}

function load(place: Place, id: string, io: JournalIo): ReturnType<typeof parseJournal> {
  return parseJournal(io.read(join(place.state, 'runs', id, JOURNAL)) ?? '');
}

export function main(argv: string[], env: Env): number {
  const [cmd, ...args] = argv;
  try {
    if (cmd !== 'start' && cmd !== 'append' && cmd !== 'park' && cmd !== 'progress' && cmd !== 'show') throw new Failure(USAGE);
    const root = findRoot(env.cwd, env.io);
    if (root === null) throw new Failure('not inside a git repository');
    const place = placeOf(root, env.fs, env.home);
    if (cmd === 'start') start(place, args, env);
    else if (cmd === 'append') append(place, args, env);
    else if (cmd === 'park') append(place, ['park', ...args], env);
    else if (cmd === 'progress') {
      const { values } = flags(args, ['--run', '--limit']);
      const id = pickRun(place, values['--run'], env.io);
      const { events, corrupt } = load(place, id, env.io);
      const progress = progressOf(events, positive(values['--limit'], STALL_LIMIT, '--limit'), observe(place, env.io));
      env.out(JSON.stringify({ id, corrupt, ...progress }));
      return progress.stop ? 1 : 0;
    } else {
      const { values } = flags(args, ['--run', '--tail']);
      const id = pickRun(place, values['--run'], env.io);
      const { events, corrupt } = load(place, id, env.io);
      env.out(JSON.stringify({ id, ...summarize(events, corrupt, positive(values['--tail'], 20, '--tail')) }));
    }
    return 0;
  } catch (error) {
    env.err(error instanceof Failure || error instanceof WorkspaceError ? error.message : `run-journal failed: ${(error as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    io: realJournalIo,
    out: (t) => console.log(t),
    err: (t) => console.error(t),
    stdin: () => readFileSync(0, 'utf8'),
    cwd: process.cwd(),
  });
}
