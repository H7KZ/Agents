import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { findRoot } from './run-journal.ts';
import { isRunId, parseJournal, redactText, roundScores } from './run-journal-core.ts';
import { ensureExclude, MAX_LINES, pathProblem, writeAtomic } from './setup-files.ts';
import { placeOf, WorkspaceError, type FsIo, type Place } from './workspace.ts';

/** Where a check can live, strongest first: architecture, types, lint, test, prose last. */
export const KINDS = ['architecture', 'types', 'lint', 'test', 'prose'] as const;
export type Kind = (typeof KINDS)[number];
export type Status = 'pending' | 'rejected' | 'applied';

export interface Row {
  id: string;
  rule: string;
  enforcer: string;
  kind: Kind;
  /** The real past mistake this row would have caught. */
  evidence: string;
  status: Status;
}

export const STORE = '.h7/retro/rows.json';
export const MAX_CELL = 300;
export const HEADING = /^#{2,4}\s+Rule\s*<->\s*enforcer\s*$/i;
const TABLE_HEAD = ['## Rule <-> enforcer', '', '| Rule | Enforcer |', '|---|---|'];

class Failure extends Error {}

const eol = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');
const lineCount = (text: string): number => text.replace(/\r?\n$/, '').split(/\r?\n/).length;

/** One redacted, single-line, bounded cell. */
export function cell(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Failure(`${name} must be a string`);
  const clean = redactText(value).replace(/<!--/g, '&lt;!--').replace(/\s+/g, ' ').trim();
  if (clean === '') throw new Failure(`${name} must not be empty`);
  if (clean.length > MAX_CELL) throw new Failure(`${name} is longer than ${MAX_CELL} characters`);
  return clean;
}

export interface Candidate {
  rule: string;
  enforcer: string;
  kind: Kind;
  evidence: string;
}

/** Validates a proposed batch; all or nothing. */
export function parseCandidates(raw: unknown): Candidate[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Failure('expected a non-empty JSON array of {rule, enforcer, kind, evidence}');
  return raw.map((item, i) => {
    const at = (name: string): string => `row ${i + 1}: ${name}`;
    const record = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    const kind = record.kind;
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) throw new Failure(`${at('kind')} must be one of ${KINDS.join(', ')}`);
    return {
      rule: cell(record.rule, at('rule')),
      enforcer: cell(record.enforcer, at('enforcer')),
      kind: kind as Kind,
      evidence: cell(record.evidence, at('evidence')),
    };
  });
}

const key = (rule: string): string => rule.replace(/\s+/g, ' ').trim().toLowerCase();

/** Parses the store; throws on anything that is not a list of well-formed rows. */
export function parseStore(text: string | null): Row[] {
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Failure(`${STORE} is not valid JSON`);
  }
  const rows = typeof raw === 'object' && raw !== null ? (raw as { rows?: unknown }).rows : undefined;
  if (!Array.isArray(rows)) throw new Failure(`${STORE} has no rows list`);
  const status: string[] = ['pending', 'rejected', 'applied'];
  const seen = new Set<string>();
  return rows.map((row) => {
    const r = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^r\d{1,6}$/.test(r.id) || seen.has(r.id) || typeof r.status !== 'string' || !status.includes(r.status)) throw new Failure(`${STORE} has a malformed row`);
    seen.add(r.id);
    return { ...parseCandidates([r])[0], id: r.id, status: r.status as Status } as Row;
  });
}

export function serializeStore(rows: Row[]): string {
  return `${JSON.stringify({ rows }, null, 2)}\n`;
}

export interface Proposed {
  rows: Row[];
  added: string[];
  duplicates: string[];
}

/** Appends new pending rows; a rule already present (any status but rejected) is reported, not added again. */
export function addRows(rows: Row[], candidates: Candidate[]): Proposed {
  const next = [...rows];
  const added: string[] = [];
  const duplicates: string[] = [];
  let n = rows.reduce((max, row) => Math.max(max, Number(row.id.slice(1))), 0);
  for (const candidate of candidates) {
    const dup = next.find((row) => row.status !== 'rejected' && key(row.rule) === key(candidate.rule));
    if (dup !== undefined) {
      duplicates.push(dup.id);
      continue;
    }
    n += 1;
    added.push(`r${n}`);
    next.push({ ...candidate, id: `r${n}`, status: 'pending' });
  }
  return { rows: next, added, duplicates };
}

const escapeCell = (text: string): string => text.replace(/[\\|]/g, (c) => `\\${c}`);

/** First cell of a table row with `\\` and `\|` escapes undone, normalised like `key`. */
function firstCell(line: string): string {
  const text = line.replace(/^\s*\|/, '');
  let cell = '';
  for (let i = 0; i < text.length && text[i] !== '|'; i += 1) {
    if (text[i] === '\\' && (text[i + 1] === '\\' || text[i + 1] === '|')) i += 1;
    cell += text[i];
  }
  return key(cell);
}

export interface Insert {
  status: 'updated' | 'unchanged' | 'no-table' | 'oversize';
  text: string;
  added: string[];
  exists: string[];
}

/**
 * Adds rows to the Rule <-> enforcer table of a document. Rows whose rule is already in the table are `exists`.
 * Without a table the document is left alone (`no-table`) unless `create` appends a new section.
 * `limit` refuses a write that would grow the file past that many lines.
 */
export function insertRows(existing: string, rows: Row[], create: boolean, limit: number | null): Insert {
  const nl = eol(existing);
  const lines = existing.split(/\r?\n/);
  const heading = lines.findIndex((line) => HEADING.test(line));
  let tableEnd = -1;
  let present: Set<string>;
  if (heading === -1) {
    present = new Set();
  } else {
    let i = heading + 1;
    while (i < lines.length && !(lines[i] as string).trimStart().startsWith('|') && !/^#/.test(lines[i] as string)) i += 1;
    const start = i;
    while (i < lines.length && (lines[i] as string).trimStart().startsWith('|')) i += 1;
    tableEnd = i;
    present = new Set(lines.slice(start + 2, i).map(firstCell));
    if (i === start) return { status: 'no-table', text: existing, added: [], exists: [] };
  }
  const exists = rows.filter((row) => present.has(key(row.rule))).map((row) => row.id);
  const fresh = rows.filter((row) => !exists.includes(row.id));
  if (fresh.length === 0) return { status: 'unchanged', text: existing, added: [], exists };
  if (heading === -1 && !create) return { status: 'no-table', text: existing, added: [], exists };
  const rendered = fresh.map((row) => `| ${escapeCell(row.rule)} | ${escapeCell(row.enforcer)} |`);
  let next: string[];
  if (heading === -1) {
    const trimmed = existing.replace(/\s+$/, '');
    next = [...(trimmed === '' ? [] : [...trimmed.split(/\r?\n/), '']), ...TABLE_HEAD, ...rendered, ''];
  } else {
    next = [...lines.slice(0, tableEnd), ...rendered, ...lines.slice(tableEnd)];
  }
  const text = next.join(nl);
  if (limit !== null && lineCount(text) > limit && lineCount(text) > lineCount(existing)) return { status: 'oversize', text: existing, added: [], exists };
  return { status: 'updated', text, added: fresh.map((row) => row.id), exists };
}

const safeLstat = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const readIfPlain = (path: string): string | null => {
  const stat = safeLstat(path);
  return stat === null || stat.isSymbolicLink() || !stat.isFile() ? null : readFileSync(path, 'utf8');
};

export interface RunSignals {
  id: string;
  task: string;
  events: number;
  corrupt: number;
  /** Verify events that reported failing layers. */
  verifyFailures: { ts: string; failing: number; layers: unknown }[];
  /** Review events that reported unresolved proven findings. */
  unresolvedFindings: { ts: string; unresolved: number; ids: unknown }[];
  /** Rounds that did not improve (score did not drop). */
  stalledRounds: { round: number; score: number | null }[];
  decisions: Record<string, unknown>[];
  notes: Record<string, unknown>[];
}

const num = (value: unknown): number => (typeof value === 'number' ? value : Array.isArray(value) ? value.length : 0);

/** Corrections and failures recorded in one journal text (already redacted when written). */
export function signalsOf(id: string, text: string): RunSignals {
  const { events, corrupt } = parseJournal(text);
  const start = events.find((event) => event.phase === 'note' && event.data.event === 'start');
  return {
    id,
    task: typeof start?.data.task === 'string' ? start.data.task : '',
    events: events.length,
    corrupt,
    verifyFailures: events.filter((e) => e.phase === 'verify' && num(e.data.failing) > 0).map((e) => ({ ts: e.ts, failing: num(e.data.failing), layers: e.data.layers })),
    unresolvedFindings: events.filter((e) => e.phase === 'review' && num(e.data.unresolved) > 0).map((e) => ({ ts: e.ts, unresolved: num(e.data.unresolved), ids: e.data.ids })),
    stalledRounds: roundScores(events).filter((round) => !round.improving).map((round) => ({ round: round.round, score: round.score })),
    decisions: events.filter((e) => e.phase === 'decision').map((e) => e.data),
    notes: events.filter((e) => e.phase === 'note' && e.data.event !== 'start').map((e) => e.data),
  };
}

/** Newest `limit` run journals under `<root>/.h7/runs`; symlinked runs and journals are skipped. */
export function collectSignals(root: string, limit: number, state: string = join(root, '.h7')): RunSignals[] {
  const dir = join(state, 'runs');
  const names = safeLstat(dir)?.isSymbolicLink() === false ? readdirSync(dir).filter(isRunId).sort() : [];
  const out: RunSignals[] = [];
  for (const id of names) {
    if (safeLstat(join(dir, id))?.isDirectory() !== true) continue;
    const text = readIfPlain(join(dir, id, 'journal.jsonl'));
    if (text !== null) out.push(signalsOf(id, text));
  }
  return out.slice(-limit);
}

const USAGE = [
  'usage: retro-rows.ts signals [--limit <n>]',
  '       retro-rows.ts propose <json | ->',
  '       retro-rows.ts list',
  '       retro-rows.ts reject <id>...',
  '       retro-rows.ts apply <id>... [--file <path>] [--create] [--write]',
].join('\n');

export interface Env {
  /** Test seams for the workspace lookup. */
  fs?: FsIo;
  home?: string;
  out(text: string): void;
  err(text: string): void;
  stdin(): string;
  cwd: string;
}

const storeFile = (place: Place): string => join(place.state, 'retro', 'rows.json');

function save(place: Place, rows: Row[]): void {
  const file = storeFile(place);
  const problem = pathProblem(file, place.contain);
  if (problem !== null) throw new Failure(problem);
  // Workspace mode keeps the rows outside the repo, so the repo's exclude file is left alone.
  if (!place.workspace && safeLstat(join(place.root, '.git'))?.isDirectory() === true) {
    const exclude = join(place.root, '.git', 'info', 'exclude');
    const result = ensureExclude(readIfPlain(exclude));
    if (result.status !== 'unchanged') writeAtomic(exclude, result.text, place.root);
  }
  writeAtomic(file, serializeStore(rows), place.contain);
}

/** A `.md` file (any case) whose path inside the repo has no `.git` segment. */
export function isMarkdownOutsideGit(root: string, target: string): boolean {
  const parts = relative(root, target).split(/[\\/]/);
  return /\.md$/i.test(target) && !parts.some((part) => part.toLowerCase() === '.git');
}

function pick(rows: Row[], ids: string[]): Row[] {
  if (ids.length === 0) throw new Failure(`name at least one row id\n${USAGE}`);
  return [...new Set(ids)].map((id) => {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) throw new Failure(`no such row: ${id}`);
    return row;
  });
}

export function main(argv: string[], env: Env): number {
  try {
    const [cmd, ...rest] = argv;
    const flags = rest.filter((arg) => arg.startsWith('--'));
    const values: string[] = [];
    const named: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i] as string;
      if (!arg.startsWith('--')) values.push(arg);
      else if (arg === '--file' || arg === '--limit') {
        named[arg] = rest[i + 1] ?? '';
        i += 1;
      } else if (arg !== '--create' && arg !== '--write') throw new Failure(`unknown option ${arg}\n${USAGE}`);
    }
    if (!['signals', 'propose', 'list', 'reject', 'apply'].includes(cmd as string)) throw new Failure(USAGE);
    const root = findRoot(env.cwd, { lstat: safeLstat });
    if (root === null) throw new Failure('not inside a git repository');
    const place = placeOf(root, env.fs, env.home);
    const rows = cmd === 'signals' ? [] : parseStore(readIfPlain(storeFile(place)));
    if (cmd === 'signals') {
      const limit = named['--limit'] === undefined ? 5 : Number(named['--limit']);
      if (!Number.isInteger(limit) || limit < 1) throw new Failure('--limit must be a positive integer');
      env.out(JSON.stringify({ runs: collectSignals(root, limit, place.state) }));
    } else if (cmd === 'list') {
      env.out(JSON.stringify({ rows, pending: rows.filter((row) => row.status === 'pending').length }));
    } else if (cmd === 'propose') {
      const [json] = values;
      let raw: unknown;
      try {
        raw = JSON.parse(json === '-' ? env.stdin() : (json as string));
      } catch {
        throw new Failure('rows are not valid JSON');
      }
      const proposed = addRows(rows, parseCandidates(raw));
      if (proposed.added.length > 0) save(place, proposed.rows);
      env.out(JSON.stringify({ added: proposed.added, duplicates: proposed.duplicates }));
    } else if (cmd === 'reject') {
      const chosen = pick(rows, values);
      if (chosen.some((row) => row.status === 'applied')) throw new Failure('an applied row cannot be rejected');
      for (const row of chosen) row.status = 'rejected';
      save(place, rows);
      env.out(JSON.stringify({ rejected: chosen.map((row) => row.id) }));
    } else {
      const chosen = pick(rows, values);
      const blocked = chosen.find((row) => row.status === 'rejected');
      if (blocked !== undefined) throw new Failure(`${blocked.id} was rejected`);
      const file = named['--file'] ?? relative(place.contain, place.agents).split(sep).join('/');
      const problem = pathProblem(file, place.contain);
      if (problem !== null) throw new Failure(problem);
      const target = resolve(place.contain, file);
      if (!isMarkdownOutsideGit(place.contain, target)) throw new Failure(`only markdown files outside .git can be edited: ${file}`);
      const existing = readIfPlain(target);
      if (existing === null) throw new Failure(`cannot read ${file}`);
      const limit = ['agents.md', 'claude.md'].includes(basename(file).toLowerCase()) ? MAX_LINES : null;
      const todo = chosen.filter((row) => row.status === 'pending');
      const result = insertRows(existing, todo, flags.includes('--create'), limit);
      const write = flags.includes('--write') && (result.status === 'updated' || result.status === 'unchanged');
      if (write) {
        if (result.status === 'updated') writeAtomic(target, result.text, place.contain);
        for (const row of todo) row.status = 'applied';
        save(place, rows);
      }
      env.out(JSON.stringify({ file, status: result.status, written: write, added: result.added, exists: result.exists, alreadyApplied: chosen.filter((row) => row.status === 'applied' && !todo.includes(row)).map((row) => row.id) }));
      return result.status === 'no-table' || result.status === 'oversize' ? 1 : 0;
    }
    return 0;
  } catch (error) {
    env.err(error instanceof Failure || error instanceof WorkspaceError ? error.message : `retro-rows failed: ${(error as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t), stdin: () => readFileSync(0, 'utf8'), cwd: process.cwd() });
}
