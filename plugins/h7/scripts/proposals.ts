import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isRunId, makeRunId, redactValue } from './run-journal-core.ts';

export const STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type Status = (typeof STATUSES)[number];

export interface Proposal {
  id: string;
  title: string;
  body: string;
  /** Where the idea came from: a run id, a repo, a session. Free text. */
  source: string;
  /** The h7 area it touches (a skill, script, hook, doc). Free text. */
  area: string;
  status: Status;
  created: string;
  decided?: string;
  note?: string;
}

export const MAX_TITLE = 120;
export const MAX_BODY = 8000;
export const MAX_SHORT = 200;
export const MAX_FILE = 65536;

class Failure extends Error {}

const USAGE = [
  'usage: proposals.ts add <json | ->   {"title","body","source"?,"area"?}',
  '       proposals.ts list [--status pending|accepted|rejected]',
  '       proposals.ts show <id>',
  '       proposals.ts accept <id> [--note <text>]',
  '       proposals.ts reject <id> [--note <text>]',
].join('\n');

/** Proposal ids are run ids: one path segment of letters, digits, dot, underscore and dash. */
export const isProposalId = isRunId;

/** `<home>/.h7/proposals`. The home must be an absolute path (H7_HOME or the user's home). */
export function proposalsDir(home: string): string {
  if (!isAbsolute(home)) throw new Failure('H7_HOME must be an absolute path');
  return join(home, '.h7', 'proposals');
}

const safeLstat = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Throws on a symlink (or junction) at `<home>/.h7` or the proposals directory. */
function checkDir(home: string): string {
  const dir = proposalsDir(home);
  for (const path of [join(home, '.h7'), dir]) {
    if (safeLstat(path)?.isSymbolicLink() === true) throw new Failure(`refusing symlink: ${path}`);
  }
  return dir;
}

function text(value: unknown, name: string, max: number, required: boolean): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new Failure(`${name} must be a string`);
  const clean = value.trim();
  if (required && clean === '') throw new Failure(`${name} must not be empty`);
  if (clean.length > max) throw new Failure(`${name} is longer than ${max} characters`);
  return clean;
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ');

/** A proposal from untrusted JSON; every string is redacted before it can reach the disk. */
export function makeProposal(raw: unknown, now: Date, id: string): Proposal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Failure('expected a JSON object {"title","body"}');
  const r = raw as Record<string, unknown>;
  const clean = redactValue({
    title: oneLine(text(r.title, 'title', MAX_TITLE, true)),
    body: text(r.body, 'body', MAX_BODY, true),
    source: oneLine(text(r.source, 'source', MAX_SHORT, false)),
    area: oneLine(text(r.area, 'area', MAX_SHORT, false)),
  }) as Pick<Proposal, 'title' | 'body' | 'source' | 'area'>;
  return { id, ...clean, status: 'pending', created: now.toISOString() };
}

/** A stored proposal, or null when the text is not a well-formed one (corrupt or foreign files are ignored, never trusted). */
export function parseProposal(raw: string, id: string): Proposal | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const strings = ['title', 'body', 'source', 'area', 'created'].every((key) => typeof p[key] === 'string');
  const optional = [p.decided, p.note].every((v) => v === undefined || typeof v === 'string');
  if (p.id !== id || !strings || !optional || !(STATUSES as readonly string[]).includes(p.status as string)) return null;
  return p as unknown as Proposal;
}

function readOne(dir: string, id: string): Proposal | null {
  const file = join(dir, `${id}.json`);
  const stat = safeLstat(file);
  if (stat === null || stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE) return null;
  return parseProposal(readFileSync(file, 'utf8'), id);
}

export interface Listing {
  proposals: Proposal[];
  /** Files in the queue that could not be read as proposals. */
  unreadable: string[];
}

export function listProposals(home: string): Listing {
  const dir = checkDir(home);
  if (safeLstat(dir) === null) return { proposals: [], unreadable: [] };
  const proposals: Proposal[] = [];
  const unreadable: string[] = [];
  for (const name of readdirSync(dir)) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!isProposalId(id)) continue;
    const found = readOne(dir, id);
    if (found === null) unreadable.push(name);
    else proposals.push(found);
  }
  return { proposals: proposals.sort((a, b) => (a.id < b.id ? -1 : 1)), unreadable };
}

/** Exclusive create in an owner-only directory; the first free `<base>`, `<base>-2`, ... wins. Never leaves a half-written file. */
function create(dir: string, proposal: (id: string) => Proposal, base: string): Proposal {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  let id = base;
  for (let n = 2; safeLstat(join(dir, `${id}.json`)) !== null; n += 1) id = `${base}-${n}`;
  const made = proposal(id);
  const temp = join(dir, `${id}.json.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(made, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, join(dir, `${id}.json`));
  return made;
}

function replace(dir: string, proposal: Proposal): void {
  const temp = join(dir, `${proposal.id}.json.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(proposal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, join(dir, `${proposal.id}.json`));
}

export function addProposal(home: string, raw: unknown, now: Date): Proposal {
  const dir = checkDir(home);
  const checked = makeProposal(raw, now, 'x');
  return create(dir, (id) => makeProposal(raw, now, id), makeRunId(now, checked.title));
}

export function decideProposal(home: string, id: string, status: 'accepted' | 'rejected', note: string, now: Date): Proposal {
  if (!isProposalId(id)) throw new Failure(`bad proposal id: ${id}`);
  const dir = checkDir(home);
  const found = readOne(dir, id);
  if (found === null) throw new Failure(`no such proposal: ${id}`);
  if (found.status !== 'pending') throw new Failure(`${id} is already ${found.status}`);
  const decided: Proposal = { ...found, status, decided: now.toISOString() };
  if (note !== '') decided.note = oneLine((redactValue(note.slice(0, MAX_SHORT)) as string).trim());
  replace(dir, decided);
  return decided;
}

export interface Env {
  home: string;
  now(): Date;
  out(text: string): void;
  err(text: string): void;
  stdin(): string;
}

function options(args: string[], allowed: string[]): { values: Record<string, string>; rest: string[] } {
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

const summary = (p: Proposal): Pick<Proposal, 'id' | 'title' | 'status' | 'area' | 'created'> => ({ id: p.id, title: p.title, status: p.status, area: p.area, created: p.created });

export function main(argv: string[], env: Env): number {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'add') {
      const { rest } = options(args, []);
      const [json, ...extra] = rest;
      if (json === undefined || extra.length > 0) throw new Failure(USAGE);
      let raw: unknown;
      try {
        raw = JSON.parse(json === '-' ? env.stdin() : json);
      } catch {
        throw new Failure('proposal is not valid JSON');
      }
      const made = addProposal(env.home, raw, env.now());
      env.out(JSON.stringify({ id: made.id, status: made.status }));
    } else if (cmd === 'list') {
      const { values, rest } = options(args, ['--status']);
      const status = values['--status'];
      if (rest.length > 0 || (status !== undefined && !(STATUSES as readonly string[]).includes(status))) throw new Failure(USAGE);
      const { proposals, unreadable } = listProposals(env.home);
      env.out(JSON.stringify({ proposals: proposals.filter((p) => status === undefined || p.status === status).map(summary), unreadable }));
    } else if (cmd === 'show') {
      const { rest } = options(args, []);
      const [id, ...extra] = rest;
      if (id === undefined || extra.length > 0) throw new Failure(USAGE);
      if (!isProposalId(id)) throw new Failure(`bad proposal id: ${id}`);
      const found = readOne(checkDir(env.home), id);
      if (found === null) throw new Failure(`no such proposal: ${id}`);
      env.out(JSON.stringify(found));
    } else if (cmd === 'accept' || cmd === 'reject') {
      const { values, rest } = options(args, ['--note']);
      const [id, ...extra] = rest;
      if (id === undefined || extra.length > 0) throw new Failure(USAGE);
      const decided = decideProposal(env.home, id, cmd === 'accept' ? 'accepted' : 'rejected', values['--note'] ?? '', env.now());
      env.out(JSON.stringify(summary(decided)));
    } else {
      throw new Failure(USAGE);
    }
    return 0;
  } catch (error) {
    env.err(error instanceof Failure ? error.message : `proposals failed: ${(error as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), {
    home: process.env.H7_HOME ?? homedir(),
    now: () => new Date(),
    out: (t) => console.log(t),
    err: (t) => console.error(t),
    stdin: () => readFileSync(0, 'utf8'),
  });
}
