import { readFileSync } from 'node:fs';

export const SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  lens: string;
  title: string;
  severity: Severity;
  file: string;
  line: number | null;
  claim: string;
  /** Command that reproduces the defect; the parent reruns it. */
  command: string;
  /** What the reviewer saw when it ran the command. */
  output: string;
}

export interface Dropped {
  lens: string;
  title: string;
  reason: string;
}

export interface Report {
  lens: string;
  findings: Finding[];
  dropped: Dropped[];
  /** Set when the text held no parsable report; the reviewer must be rerun or logged as failed, never counted as clean. */
  error: string | null;
}

export interface Absorbed {
  lens: string;
  title: string;
  severity: Severity;
}

export interface Merged extends Omit<Finding, 'lens'> {
  id: string;
  lenses: string[];
  /** Duplicates folded into this finding: nothing merges without a trace. */
  merged: Absorbed[];
}

/** A lens that reports more than this is noise; the rest are dropped with a reason. */
export const MAX_FINDINGS_PER_LENS = 10;
/** Longest command output kept per finding; the rest is cut with a marker. */
export const MAX_OUTPUT = 8192;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const isReport = (value: unknown): value is Record<string, unknown> => isObject(value) && Array.isArray(value.findings);

/**
 * The report object, or null. Candidates start after each fence-opening line (```json) or at the start of the text, last first, and are
 * tried at every later fence and at the end of the text, shortest first, so a fenced block inside a finding's output cannot cut the JSON short.
 * Never throws.
 */
export function extractReport(body: string): Record<string, unknown> | null {
  const starts = [...body.matchAll(/^[ \t]*`{3,}[ \t]*(?:json)?[ \t]*\r?\n/gim)].map((m) => m.index + m[0].length).reverse();
  for (const start of [...starts, 0]) {
    const ends = [...body.slice(start).matchAll(/`{3,}/g)].map((m) => start + m.index);
    for (const end of [...ends, body.length]) {
      try {
        const parsed: unknown = JSON.parse(body.slice(start, end));
        if (isReport(parsed)) return parsed;
      } catch {
        // not a complete JSON document yet: try a longer candidate
      }
    }
  }
  return null;
}

const clip = (output: string): string => (output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}
[truncated ${output.length - MAX_OUTPUT} chars]` : output);

/** Proof gate: a finding with no reproducing command or no captured output is dropped, whatever it claims. */
export function parseReport(body: string, lensHint = 'unknown'): Report {
  const raw = extractReport(body);
  if (raw === null) return { lens: lensHint, findings: [], dropped: [], error: 'no JSON report with a findings array' };
  const lens = text(raw.lens) || lensHint;
  const findings: Finding[] = [];
  const dropped: Dropped[] = [];
  for (const item of raw.findings as unknown[]) {
    const entry = isObject(item) ? item : {};
    const title = text(entry.title) || '(untitled)';
    const command = text(entry.command);
    const output = text(entry.output);
    const reason = command === '' ? 'no reproducing command' : output === '' ? 'no command output' : title === '(untitled)' ? 'no title' : null;
    if (reason !== null) {
      dropped.push({ lens, title, reason });
      continue;
    }
    if (findings.length >= MAX_FINDINGS_PER_LENS) {
      dropped.push({ lens, title, reason: `over the cap of ${MAX_FINDINGS_PER_LENS} findings per lens` });
      continue;
    }
    const severity = SEVERITIES.find((s) => s === text(entry.severity).toLowerCase()) ?? 'low';
    const line = typeof entry.line === 'number' && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null;
    findings.push({ lens, title, severity, file: text(entry.file), line, claim: text(entry.claim), command, output: clip(output) });
  }
  return { lens, findings, dropped, error: null };
}

const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const rank = (severity: Severity): number => SEVERITIES.indexOf(severity);

/** Keys under which two findings count as the same defect: same command at the same place, or same title at the same place. A shared command alone (`npm test`) never merges. */
const keysOf = (f: Finding): string[] => {
  const place = `${f.file}:${f.line ?? ''}`;
  return [`cmd:${place}:${f.command.replace(/\s+/g, ' ')}`, `loc:${place}:${norm(f.title)}`];
};

/** Dedupe across reviewers (strongest severity wins, lenses accumulate), then rank: severity, agreeing lenses, file, line. Ids are F1.. in rank order. */
export function mergeFindings(reports: Report[]): Merged[] {
  const all = reports.flatMap((r) => r.findings).sort((a, b) => rank(a.severity) - rank(b.severity));
  const seen = new Map<string, Merged>();
  const unique: Merged[] = [];
  for (const finding of all) {
    const keys = keysOf(finding);
    const hit = keys.map((key) => seen.get(key)).find((m) => m !== undefined);
    if (hit !== undefined) {
      if (!hit.lenses.includes(finding.lens)) hit.lenses.push(finding.lens);
      hit.merged.push({ lens: finding.lens, title: finding.title, severity: finding.severity });
      for (const key of keys) seen.set(key, hit);
      continue;
    }
    const { lens, ...rest } = finding;
    const merged: Merged = { ...rest, id: '', lenses: [lens], merged: [] };
    for (const key of keys) seen.set(key, merged);
    unique.push(merged);
  }
  unique.sort((a, b) => rank(a.severity) - rank(b.severity) || b.lenses.length - a.lenses.length || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.title.localeCompare(b.title));
  unique.forEach((m, i) => {
    m.lenses.sort();
    m.id = `F${i + 1}`;
  });
  return unique;
}

export interface Summary {
  findings: Merged[];
  dropped: Dropped[];
  errors: Array<{ file: string; error: string }>;
}

export type Read = (file: string) => string | null;

export const realRead: Read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Lens hint from `.../security.md`: the file's base name without extension. */
const hintOf = (file: string): string => (file.split(/[\\/]/).at(-1) as string).replace(/\.[^.]*$/, '');

export function summarize(files: string[], read: Read): Summary {
  const reports: Report[] = [];
  const errors: Summary['errors'] = [];
  for (const file of files) {
    const body = read(file);
    if (body === null) {
      errors.push({ file, error: 'cannot read file' });
      continue;
    }
    const report = parseReport(body, hintOf(file));
    if (report.error !== null) errors.push({ file, error: report.error });
    reports.push(report);
  }
  return { findings: mergeFindings(reports), dropped: reports.flatMap((r) => r.dropped), errors };
}

const USAGE = 'usage: review-findings.ts merge <reviewer-output-file>... | keep <findings.json> <id>...';

/** merge: parse reviewer outputs, drop the unproven, dedupe, rank. keep: the findings the parent reproduced (by id). */
export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, read: Read = realRead): number {
  const [cmd, first, ...rest] = argv;
  if (cmd === 'merge' && first !== undefined) {
    out(JSON.stringify(summarize([first, ...rest], read)));
    return 0;
  }
  if (cmd === 'keep' && first !== undefined) {
    const body = read(first);
    let findings: unknown;
    try {
      findings = (JSON.parse(body ?? '') as Record<string, unknown>).findings;
    } catch {
      findings = null;
    }
    if (!Array.isArray(findings)) {
      err(`${first} is missing or not a merge result`);
      return 2;
    }
    const ids = new Set(rest);
    const known = new Set((findings as Merged[]).map((f) => f.id));
    const unknown = rest.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      err(`unknown finding ids: ${unknown.join(', ')}`);
      return 2;
    }
    const all = findings as Merged[];
    out(JSON.stringify({ kept: all.filter((f) => ids.has(f.id)), rejected: all.filter((f) => !ids.has(f.id)).map((f) => f.id) }));
    return 0;
  }
  err(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
