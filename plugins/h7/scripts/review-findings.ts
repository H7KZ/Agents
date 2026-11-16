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

export interface Rerun {
  /** auto: the parent may run it without asking. needs-approval: ask the user first, naming the command. */
  status: 'auto' | 'needs-approval';
  reason: string;
}

const auto = (reason: string): Rerun => ({ status: 'auto', reason });
const needs = (reason: string): Rerun => ({ status: 'needs-approval', reason });

const META = /[;&|<>`$\n\r\\(){}]/;
const squash = (command: string): string => command.trim().replace(/\s+/g, ' ');

/** Words of a simple command line; quotes group, nothing expands. Null on an unbalanced quote. */
function words(command: string): string[] | null {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  let open = false;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
    } else if (/\s/.test(ch)) {
      if (open) out.push(current);
      current = '';
      open = false;
    } else {
      current += ch;
      open = true;
    }
  }
  if (quote !== null) return null;
  if (open) out.push(current);
  return out;
}

interface Spec {
  /** Letters allowed as single or bundled short options (-n, -rn). Every letter must be safe on its own. */
  letters: string;
  /** Exact long options. */
  long: string[];
  /** Whether \`-e <pattern>\` is allowed (the pattern may then contain spaces). */
  pattern: boolean;
}

const spec = (letters: string, long: string[] = [], pattern = false): Spec => ({ letters, long, pattern });

const VIEW_LONG = ['--stat', '--name-only', '--name-status', '--no-color', '--no-ext-diff', '--no-textconv', '--oneline', '--cached', '--staged', '--shortstat', '--numstat', '--summary', '--patch', '--no-patch', '--no-merges', '--first-parent', '--reverse', '--graph', '--abbrev-commit'];

/** Exact, known-safe options per program or git subcommand. Anything else (abbreviations, attached values, unknown letters) needs approval. */
const SPECS: Record<string, Spec> = {
  'git diff': spec('nps', VIEW_LONG),
  'git show': spec('nps', VIEW_LONG),
  'git log': spec('nps', VIEW_LONG),
  'git grep': spec('niwFEIl', ['--no-color', '--line-number', '--ignore-case', '--word-regexp', '--fixed-strings', '--files-with-matches'], true),
  'git blame': spec('w', ['--porcelain']),
  'git ls-files': spec('', ['--cached', '--others', '--exclude-standard', '--deleted', '--modified']),
  'git cat-file': spec('pts'),
  'git rev-parse': spec('', ['--short', '--abbrev-ref', '--verify', '--show-toplevel', '--is-inside-work-tree']),
  'git status': spec('sb', ['--short', '--branch', '--porcelain']),
  grep: spec('niwFErl', ['--color=never'], true),
  rg: spec('niwFl', ['--no-heading', '--no-color', '--fixed-strings', '--line-number', '--ignore-case', '--word-regexp', '--files-with-matches'], true),
};

/** Value-carrying options that are safe only with a number or a plain word attached. */
const NUMERIC = /^(?:--unified=\d+|-U\d+|-n\d+|--max-count=\d+)$/;
const FORMAT = /^--(?:format|pretty)=[\w%:-]+$/;
/** A revision or repo-relative path: no glob characters, no leading dash, slash or tilde, no spaces. */
const PLAIN = /^[A-Za-z0-9_.][A-Za-z0-9_.\/@:^~+,-]*$/;
/** The pattern after -e: plain text, no glob or regex-class characters, no leading dash. */
const PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_ .:,@%^+=\/-]*$/;

const plainPath = (token: string): boolean => PLAIN.test(token) && !/^[A-Za-z]:/.test(token) && !token.split('/').includes('..');

function optionAllowed(arg: string, allowed: Spec, git: boolean): boolean {
  if (allowed.long.includes(arg)) return true;
  if (git && (NUMERIC.test(arg) || FORMAT.test(arg))) return true;
  return /^-[A-Za-z]+$/.test(arg) && [...arg.slice(1)].every((letter) => allowed.letters.includes(letter));
}

/**
 * Can the parent rerun a reviewer-supplied command without asking? Only a single simple read-only command qualifies:
 * a git read subcommand, grep or rg with exactly allowlisted options over plain repo-relative revisions and paths,
 * or the exact test command recorded for the repo. Everything else, including anything this function does not understand,
 * needs the user's approval. It narrows what a reviewer can make the parent run; it is not a sandbox (a repo's own
 * textconv or attribute drivers and symlinks inside the repo are outside what it can see).
 */
export function classifyCommand(command: string, testCommands: string[] = []): Rerun {
  if (squash(command) === '') return needs('empty command');
  if (testCommands.some((t) => squash(t) === squash(command))) return auto('the repo\'s recorded test command');
  if (META.test(command)) return needs('shell metacharacter (; & | < > backtick $ backslash parentheses braces, or a newline)');
  const tokens = words(command);
  if (tokens === null) return needs('unbalanced quote');
  const [prog, ...args] = tokens as [string, ...string[]];
  const git = prog === 'git';
  if (!git && prog !== 'grep' && prog !== 'rg') return needs('not git, grep, rg or the recorded test command');
  const name = git ? 'git ' + (args.shift() ?? '') : prog;
  const allowed = SPECS[name];
  if (allowed === undefined) return needs(name + ' is not an allowlisted read-only command');
  let paths = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--' && !paths) {
      paths = true;
    } else if (arg === '-e' && allowed.pattern && !paths) {
      const value = args[++i];
      if (value === undefined || !PATTERN.test(value)) return needs('-e needs a plain pattern');
    } else if (arg.startsWith('-') && !paths) {
      if (!optionAllowed(arg, allowed, git)) return needs('option ' + arg + ' is not on the allowlist');
    } else if (!plainPath(arg)) {
      return needs('not a plain repo-relative path or revision: ' + arg);
    }
  }
  return auto('single read-only ' + name + ' command with allowlisted options over repo paths');
}

const USAGE = 'usage: review-findings.ts merge <reviewer-output-file>... | keep <findings.json> <id>... | classify <findings.json> [--test <command>]...';

function loadFindings(read: Read, file: string): Merged[] | null {
  try {
    const findings = (JSON.parse(read(file) ?? '') as Record<string, unknown>).findings;
    return Array.isArray(findings) ? (findings as Merged[]) : null;
  } catch {
    return null;
  }
}

/** merge: parse reviewer outputs, drop the unproven, dedupe, rank. keep: the findings the parent reproduced (by id). classify: which commands the parent may rerun unasked. */
export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, read: Read = realRead): number {
  const [cmd, first, ...rest] = argv;
  if (cmd === 'merge' && first !== undefined) {
    out(JSON.stringify(summarize([first, ...rest], read)));
    return 0;
  }
  if ((cmd === 'keep' || cmd === 'classify') && first !== undefined) {
    const all = loadFindings(read, first);
    if (all === null) {
      err(first + ' is missing or not a merge result');
      return 2;
    }
    if (cmd === 'classify') {
      const tests: string[] = [];
      for (let i = 0; i < rest.length; i += 2) {
        const value = rest[i + 1];
        if (rest[i] !== '--test' || value === undefined) {
          err(USAGE);
          return 2;
        }
        tests.push(value);
      }
      const results = all.map((f) => ({ id: f.id, ...classifyCommand(f.command, tests) }));
      out(JSON.stringify({ results, needsApproval: results.filter((r) => r.status === 'needs-approval').map((r) => r.id) }));
      return 0;
    }
    const ids = new Set(rest);
    const known = new Set(all.map((f) => f.id));
    const unknown = rest.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      err('unknown finding ids: ' + unknown.join(', '));
      return 2;
    }
    out(JSON.stringify({ kept: all.filter((f) => ids.has(f.id)), rejected: all.filter((f) => !ids.has(f.id)).map((f) => f.id) }));
    return 0;
  }
  err(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
