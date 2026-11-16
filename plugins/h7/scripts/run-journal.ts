import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, lstatSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isPhase, isRunId, makeEvent, makeRunId, parseJournal, progressOf, serializeEvent, STALL_LIMIT, summarize } from './run-journal-core.ts';
import { ensureExclude } from './setup-files.ts';

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
  /** Replace a whole file (temp file plus rename). */
  write(path: string, text: string): void;
  /** Append one line in a single write; starts a new line first when the file ends in a torn one. */
  append(path: string, line: string): void;
}

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
  write(path, text) {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, path);
  },
  append(path, line) {
    const fd = openSync(path, 'a+');
    try {
      const size = fstatSync(fd).size;
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
  io: JournalIo;
  out(text: string): void;
  err(text: string): void;
  stdin(): string;
  cwd: string;
}

const USAGE = [
  'usage: run-journal.ts start [--task <text>]',
  '       run-journal.ts append [--run <id>] <phase> <json | ->',
  '       run-journal.ts progress [--run <id>] [--limit <n>]',
  '       run-journal.ts show [--run <id>] [--tail <n>]',
].join('\n');

export const RUNS_DIR = '.h7/runs';
export const JOURNAL = 'journal.jsonl';

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

function latestRun(root: string, io: JournalIo): string {
  const ids = io.readdir(join(root, RUNS_DIR)).filter(isRunId).sort();
  const id = ids[ids.length - 1];
  if (id === undefined) throw new Failure('no run found; start one with: run-journal.ts start');
  return id;
}

function pickRun(root: string, requested: string | undefined, io: JournalIo): string {
  const id = requested ?? latestRun(root, io);
  if (!isRunId(id)) throw new Failure(`bad run id: ${id}`);
  checkLinks(root, ['.h7', 'runs', id, JOURNAL], io);
  if (io.lstat(join(root, RUNS_DIR, id))?.isDirectory() !== true) throw new Failure(`no such run: ${id}`);
  return id;
}

function start(root: string, args: string[], env: Env): void {
  const { values } = flags(args, ['--task']);
  const { io } = env;
  checkLinks(root, ['.h7', 'runs'], io);
  const base = makeRunId(io.now(), values['--task'] ?? '');
  let id = base;
  for (let n = 2; io.lstat(join(root, RUNS_DIR, id)) !== null; n += 1) id = `${base}-${n}`;
  io.mkdir(join(root, RUNS_DIR, id));
  io.append(join(root, RUNS_DIR, id, JOURNAL), serializeEvent(makeEvent('note', { event: 'start', task: values['--task'] ?? '' }, io.now())));
  let excluded = false;
  if (io.lstat(join(root, '.git'))?.isDirectory() === true) {
    const file = join(root, '.git', 'info', 'exclude');
    const result = ensureExclude(io.read(file));
    if (result.status !== 'unchanged') {
      io.mkdir(join(root, '.git', 'info'));
      io.write(file, result.text);
    }
    excluded = true;
  }
  env.out(JSON.stringify({ id, dir: `${RUNS_DIR}/${id}`, journal: `${RUNS_DIR}/${id}/${JOURNAL}`, excluded }));
}

function append(root: string, args: string[], env: Env): void {
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
  const id = pickRun(root, values['--run'], env.io);
  env.io.append(join(root, RUNS_DIR, id, JOURNAL), serializeEvent(makeEvent(phase, record, env.io.now())));
  env.out(JSON.stringify({ id, phase }));
}

function load(root: string, id: string, io: JournalIo): ReturnType<typeof parseJournal> {
  return parseJournal(io.read(join(root, RUNS_DIR, id, JOURNAL)) ?? '');
}

export function main(argv: string[], env: Env): number {
  const [cmd, ...args] = argv;
  try {
    if (cmd !== 'start' && cmd !== 'append' && cmd !== 'progress' && cmd !== 'show') throw new Failure(USAGE);
    const root = findRoot(env.cwd, env.io);
    if (root === null) throw new Failure('not inside a git repository');
    if (cmd === 'start') start(root, args, env);
    else if (cmd === 'append') append(root, args, env);
    else if (cmd === 'progress') {
      const { values } = flags(args, ['--run', '--limit']);
      const id = pickRun(root, values['--run'], env.io);
      const { events, corrupt } = load(root, id, env.io);
      const progress = progressOf(events, positive(values['--limit'], STALL_LIMIT, '--limit'));
      env.out(JSON.stringify({ id, corrupt, ...progress }));
      return progress.stop ? 1 : 0;
    } else {
      const { values } = flags(args, ['--run', '--tail']);
      const id = pickRun(root, values['--run'], env.io);
      const { events, corrupt } = load(root, id, env.io);
      env.out(JSON.stringify({ id, ...summarize(events, corrupt, positive(values['--tail'], 20, '--tail')) }));
    }
    return 0;
  } catch (error) {
    env.err(error instanceof Failure ? error.message : `run-journal failed: ${(error as Error).message}`);
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
