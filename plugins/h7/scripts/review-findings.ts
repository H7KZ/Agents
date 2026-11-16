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

export interface Merged extends Omit<Finding, 'lens'> {
  id: string;
  lenses: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The last fenced block that parses to a report object, else the whole text as JSON. Null when neither does. Never throws. */
export function extractReport(body: string): Record<string, unknown> | null {
  const blocks = [...body.matchAll(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1] as string).reverse();
  for (const candidate of [...blocks, body]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isObject(parsed) && Array.isArray(parsed.findings)) return parsed;
    } catch {
      // not JSON: try the next candidate
    }
  }
  return null;
}

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
    const severity = SEVERITIES.find((s) => s === text(entry.severity).toLowerCase()) ?? 'low';
    const line = typeof entry.line === 'number' && Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null;
    findings.push({ lens, title, severity, file: text(entry.file), line, claim: text(entry.claim), command, output });
  }
  return { lens, findings, dropped, error: null };
}

const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const rank = (severity: Severity): number => SEVERITIES.indexOf(severity);

/** Keys under which two findings count as the same defect: the same command, or the same title at the same place. */
const keysOf = (f: Finding): string[] => [`cmd:${f.command.replace(/\s+/g, ' ')}`, `loc:${f.file}:${f.line ?? ''}:${norm(f.title)}`];

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
      for (const key of keys) seen.set(key, hit);
      continue;
    }
    const { lens, ...rest } = finding;
    const merged = { ...rest, id: '', lenses: [lens] };
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
