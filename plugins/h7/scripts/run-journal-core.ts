import { redact } from './log.ts';

export const PHASES = ['research', 'grill', 'implement', 'verify', 'review', 'loop', 'ship', 'decision', 'note'] as const;
export type Phase = (typeof PHASES)[number];

/** Consecutive non-improving rounds after which the run stops and reports. */
export const STALL_LIMIT = 5;
/** Longest string kept in an event; the rest is cut with a marker. */
export const MAX_STRING = 4000;
/** Longest serialized event line; a bigger one is replaced by a truncated preview so one append stays one small write. */
export const MAX_LINE = 32768;
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

const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/g;
const URL_USER = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;
const SECRET_KEY = /token|secret|passw(?:or)?d|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credential|cookie/i;

/** Secrets out of free text: URL credentials, bearer and flag values, `NAME_TOKEN=...`, and well-known token shapes. */
export function redactText(text: string): string {
  return redact(text.replace(URL_USER, '$1[REDACTED]@')).replace(TOKEN_SHAPES, '[REDACTED]');
}

/** Redacts every string, and any string or number under a secret-looking key. Bounded in depth, items and string length. Never throws on JSON input. */
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
    entries.map(([key, item]) => [key, SECRET_KEY.test(key) && (typeof item === 'string' || typeof item === 'number') ? '[REDACTED]' : redactValue(item, depth + 1)]),
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

export interface Round {
  round: number;
  failing: number;
  unresolved: number;
  score: number;
  improving: boolean;
}

/**
 * Score of a round = failing verification layers + unresolved proven findings, as last reported by a verify, review or loop event up to
 * the loop event that closes the round (a figure not reported again carries over). Improving = a measurable decrease against the round
 * before, or a score of zero; the first round is the baseline and counts as improving. Events after the last loop event are an open round.
 */
export function roundScores(events: JournalEvent[]): Round[] {
  const rounds: Round[] = [];
  let failing = 0;
  let unresolved = 0;
  for (const event of events) {
    if (event.phase !== 'verify' && event.phase !== 'review' && event.phase !== 'loop') continue;
    failing = countOf(event.data.failing) ?? failing;
    unresolved = countOf(event.data.unresolved) ?? unresolved;
    if (event.phase !== 'loop') continue;
    const score = failing + unresolved;
    const before = rounds[rounds.length - 1];
    rounds.push({ round: rounds.length + 1, failing, unresolved, score, improving: before === undefined || score < before.score || score === 0 });
  }
  return rounds;
}

export interface Progress {
  rounds: Round[];
  /** Trailing rounds that did not improve. */
  streak: number;
  limit: number;
  stop: boolean;
  /** The last closed round has nothing failing or unresolved: only the rest of the done predicate is left. */
  clean: boolean;
  reason: string;
}

export function progressOf(events: JournalEvent[], limit = STALL_LIMIT): Progress {
  const rounds = roundScores(events);
  let streak = 0;
  for (let i = rounds.length - 1; i >= 0 && !(rounds[i] as Round).improving; i -= 1) streak += 1;
  const stop = streak >= limit;
  const last = rounds[rounds.length - 1];
  const clean = last !== undefined && last.score === 0;
  let reason: string;
  if (stop) reason = `${streak} consecutive rounds without a decrease in failing layers plus unresolved findings: stop and report`;
  else if (last === undefined) reason = 'no closed round yet';
  else if (clean) reason = 'last round is clean: check the rest of the done predicate';
  else reason = `${streak} of ${limit} non-improving rounds`;
  return { rounds, streak, limit, stop, clean, reason };
}

export interface Summary {
  events: number;
  corrupt: number;
  phases: Record<string, number>;
  last: JournalEvent[];
}

export function summarize(events: JournalEvent[], corrupt: number, tail: number): Summary {
  const phases: Record<string, number> = {};
  for (const event of events) phases[event.phase] = (phases[event.phase] ?? 0) + 1;
  return { events: events.length, corrupt, phases, last: events.slice(Math.max(0, events.length - tail)) };
}

/** `YYYYMMDD-HHMMSS-<slug>` from the clock and the task text. */
export function makeRunId(now: Date, task: string): string {
  const digits = now.toISOString().slice(0, 19).replace(/\D/g, '');
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${digits.slice(0, 8)}-${digits.slice(8)}-${slug === '' ? 'run' : slug}`;
}
