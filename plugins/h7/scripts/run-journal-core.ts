import { redact } from './log.ts';

export const PHASES = ['research', 'grill', 'implement', 'verify', 'review', 'loop', 'ship', 'decision', 'note', 'park'] as const;
export type Phase = (typeof PHASES)[number];

/** Consecutive non-improving rounds after which the run stops and reports. */
export const STALL_LIMIT = 5;
/** Longest string kept in an event; the rest is cut with a marker. */
export const MAX_STRING = 4000;
/** Longest serialized event line; a bigger one is replaced by a truncated preview so one append stays one small write. */
export const MAX_LINE = 32768;
export const MAX_PARKED = 50;
const MAX_ITEMS = 200;
const MAX_DEPTH = 8;
const PREVIEW = 2000;

export interface JournalEvent {
  ts: string;
  phase: Phase;
  data: Record<string, unknown>;
}

export const isPhase = (name: string): name is Phase => (PHASES as readonly string[]).includes(name);

/** A run id is a single path segment: no separators, no dots at the start, no traversal. */
export const isRunId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) && !id.includes('..');

const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{30,}|glpat-[\w-]{20,}|AIza[\w-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** Everything up to the last @ of the token: a password may itself hold / or @. */
const URL_USER = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s'"]*@/gi;
const USER_FLAG = /(\s(?:-u|--user)\s+)[^\s:]*:\S*/g;
const SECRET_KEY = /token|secret|passw(?:or)?d|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credential|cookie/i;

/** Secrets out of free text: URL credentials, bearer and flag values, `NAME_TOKEN=...`, and well-known token shapes. */
export function redactText(text: string): string {
  return redact(text.replace(PEM, '[REDACTED]').replace(URL_USER, '$1[REDACTED]@').replace(USER_FLAG, '$1[REDACTED]')).replace(TOKEN_SHAPES, '[REDACTED]');
}

/** Redacts every string and key, and blanks whatever sits under a secret-looking key (any type). Bounded in depth, items and string length. Never throws on JSON input. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const clean = redactText(value);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}[truncated ${clean.length - MAX_STRING} chars]` : clean;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1));
  const entries = Object.entries(value).slice(0, MAX_ITEMS);
  return Object.fromEntries(
    entries.map(([key, item]) => [redactText(key), SECRET_KEY.test(key) ? '[REDACTED]' : redactValue(item, depth + 1)]),
  );
}

export function makeEvent(phase: Phase, data: Record<string, unknown>, now: Date): JournalEvent {
  return { ts: now.toISOString(), phase, data: redactValue(data) as Record<string, unknown> };
}

/** One line of JSON, no newline inside. Oversized events keep a preview of their (already redacted) data. */
export function serializeEvent(event: JournalEvent): string {
  const line = JSON.stringify(event);
  if (line.length <= MAX_LINE) return line;
  const data = { truncated: true, chars: line.length, preview: JSON.stringify(event.data).slice(0, PREVIEW) };
  return JSON.stringify({ ts: event.ts, phase: event.phase, data });
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Valid events in order, and how many non-empty lines were unreadable. Never throws; a torn or corrupt line costs only itself. */
export function parseJournal(text: string): { events: JournalEvent[]; corrupt: number } {
  const events: JournalEvent[] = [];
  let corrupt = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      corrupt += 1;
      continue;
    }
    if (!isObject(raw) || typeof raw.ts !== 'string' || Number.isNaN(Date.parse(raw.ts)) || typeof raw.phase !== 'string' || !isPhase(raw.phase) || !isObject(raw.data)) {
      corrupt += 1;
      continue;
    }
    events.push({ ts: raw.ts, phase: raw.phase, data: raw.data });
  }
  return { events, corrupt };
}

/** A count from a number (non-negative integer) or an array (its length); null for anything else. */
export function countOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  return Array.isArray(value) ? value.length : null;
}

/** Why an event's counts cannot be trusted, or null. Loop events must carry both counts; verify and review events must not carry a bad one; other phases are free. */
export function countProblem(phase: Phase, data: Record<string, unknown>): string | null {
  if (phase !== 'verify' && phase !== 'review' && phase !== 'loop') return null;
  for (const name of ['failing', 'unresolved']) {
    const present = name in data;
    if (present ? countOf(data[name]) === null : phase === 'loop') return `${phase} event needs "${name}" as a non-negative integer or an array${present ? ` (got ${JSON.stringify(data[name])})` : ''}`;
  }
  return null;
}

/** Number of proven findings in a `proven.json` text (`kept[]`), null when it is not one. */
export function provenCount(text: string): number | null {
  try {
    const kept = (JSON.parse(text) as { kept?: unknown } | null)?.kept;
    return Array.isArray(kept) ? kept.length : null;
  } catch {
    return null;
  }
}

export interface Round {
  round: number;
  /** Null (with score) when the loop event's counts were missing or invalid: the round is unknown, never zero. */
  failing: number | null;
  unresolved: number | null;
  score: number | null;
  improving: boolean;
}

/**
 * One round per loop event; its score is failing verify layers plus unresolved proven findings as that event reports them. A round improves
 * when its score is below the best score of the rounds before it (a zero score always counts), so oscillating cannot reset the brake.
 * The first round has nothing to beat: it counts as improving only when it is already zero, so five stuck rounds are five rounds.
 * A round with a missing or invalid count is unknown: never improving, never clean, and it does not move the best score.
 */
export function roundScores(events: JournalEvent[]): Round[] {
  const rounds: Round[] = [];
  let best: number | null = null;
  for (const event of events) {
    if (event.phase !== 'loop') continue;
    const failing = countOf(event.data.failing);
    const unresolved = countOf(event.data.unresolved);
    const round = rounds.length + 1;
    if (failing === null || unresolved === null) {
      rounds.push({ round, failing: null, unresolved: null, score: null, improving: false });
      continue;
    }
    const score = failing + unresolved;
    rounds.push({ round, failing, unresolved, score, improving: score === 0 || (best !== null && score < best) });
    best = best === null ? score : Math.min(best, score);
  }
  return rounds;
}

/** What the files on disk say, when present: failing verify layers from `.h7/verify.json`, proven findings from `.h7/review/proven.json`. */
export interface Observed {
  failing: number | null;
  unresolved: number | null;
  /** Files that exist but cannot be read: nothing can be called clean while they are. */
  unreadable: string[];
}

export const NO_OBSERVED: Observed = { failing: null, unresolved: null, unreadable: [] };

export interface Progress {
  rounds: Round[];
  /** Items recorded with `park`: things that need a human, left for the end of an unattended run. */
  parked: number;
  /** Trailing rounds that did not improve. */
  streak: number;
  /** Effective limit: a larger request is capped at STALL_LIMIT, a smaller one lowers it. */
  limit: number;
  stop: boolean;
  /** The last closed round reports nothing failing or unresolved and the files on disk agree: only the rest of the done predicate is left. */
  clean: boolean;
  reason: string;
  warnings: string[];
  observed: Observed;
}

export function progressOf(events: JournalEvent[], limit = STALL_LIMIT, observed: Observed = NO_OBSERVED): Progress {
  const rounds = roundScores(events);
  const cap = Math.min(limit, STALL_LIMIT);
  let streak = 0;
  for (let i = rounds.length - 1; i >= 0 && !(rounds[i] as Round).improving; i -= 1) streak += 1;
  const stop = streak >= cap;
  const last = rounds[rounds.length - 1];
  const warnings = observed.unreadable.map((file) => `unreadable: ${file}`);
  if (last !== undefined && observed.failing !== null && observed.failing !== last.failing) warnings.push(`reported failing ${last.failing ?? 'unknown'} but .h7/verify.json shows ${observed.failing}`);
  if (last !== undefined && observed.unresolved !== null && observed.unresolved !== last.unresolved) warnings.push(`reported unresolved ${last.unresolved ?? 'unknown'} but .h7/review/proven.json shows ${observed.unresolved}`);
  const zero = last !== undefined && last.score === 0;
  const clean = zero && warnings.length === 0;
  let reason: string;
  if (stop) reason = `${streak} consecutive rounds without beating the best score (failing layers plus unresolved findings): stop and report`;
  else if (last === undefined) reason = 'no closed round yet';
  else if (zero && !clean) reason = 'reported counts are zero but the files on disk disagree: not clean';
  else if (clean) reason = 'last round is clean: check the rest of the done predicate';
  else reason = `${streak} of ${cap} non-improving rounds`;
  return { rounds, parked: events.filter((event) => event.phase === 'park').length, streak, limit: cap, stop, clean, reason, warnings, observed };
}

export interface Summary {
  /** The run was started with --unattended. */
  unattended: boolean;
  /** Parked items (newest last, at most MAX_PARKED), each with its timestamp. */
  parked: Record<string, unknown>[];
  events: number;
  corrupt: number;
  phases: Record<string, number>;
  last: JournalEvent[];
}

export function summarize(events: JournalEvent[], corrupt: number, tail: number): Summary {
  const phases: Record<string, number> = {};
  for (const event of events) phases[event.phase] = (phases[event.phase] ?? 0) + 1;
  const parked = events.filter((event) => event.phase === 'park').slice(-MAX_PARKED).map((event) => ({ ts: event.ts, ...event.data }));
  const first = events[0];
  const unattended = first !== undefined && startIsUnattended(JSON.stringify(first));
  return { unattended, parked, events: events.length, corrupt, phases, last: events.slice(Math.max(0, events.length - tail)) };
}

/** `YYYYMMDD-HHMMSS-<slug>` from the clock and the task text. */
export function makeRunId(now: Date, task: string): string {
  const digits = now.toISOString().slice(0, 19).replace(/\D/g, '');
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${digits.slice(0, 8)}-${digits.slice(8)}-${slug === '' ? 'run' : slug}`;
}

/** True when a journal's first line is a start event recorded with unattended: true. Never throws; anything else (corrupt, other shape) is false. */
export function startIsUnattended(firstLine: string): boolean {
  try {
    const raw = JSON.parse(firstLine) as { phase?: unknown; data?: { event?: unknown; unattended?: unknown } | null } | null;
    return raw?.phase === 'note' && raw.data?.event === 'start' && raw.data.unattended === true;
  } catch {
    return false;
  }
}
