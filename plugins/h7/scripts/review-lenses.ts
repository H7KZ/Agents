import { readFileSync } from 'node:fs';
import type { FileKind } from './verify-scope.ts';

export const LENSES = ['spec', 'standards', 'adversarial', 'security', 'performance', 'test-quality', 'architecture'] as const;
export type Lens = (typeof LENSES)[number];

export interface ChangedFile {
  path: string;
  kind: FileKind;
  ranges: Array<[number, number]>;
  whole: boolean;
}

export interface Choice {
  lens: Lens;
  reason: string;
}

export interface Plan {
  selected: Choice[];
  /** Logged by the driver in the review report: a skipped lens is never silent. */
  skipped: Choice[];
  stats: { files: number; source: number; test: number; other: number; changedLines: number };
}

/** An untracked file has no ranges; count it as this many changed lines. */
export const WHOLE_FILE_LINES = 200;
/** Lines changed in source at which size alone makes performance and architecture worth a look. */
export const PERF_LINES = 150;
export const ARCH_LINES = 300;
export const ARCH_FILES = 3;

const SECURITY_PATH =
  /auth|login|session|token|secret|crypt|passw|cred|permission|sanitiz|escape|upload|deserial|\bsql|query|exec|spawn|shell|command|guard|hook|webhook|cors|csrf|oauth|jwt|(^|\/)\.env|dockerfile|\.github\/workflows|package(-lock)?\.json|requirements.*\.txt|cargo\.(toml|lock)|go\.(mod|sum)|pnpm-lock|yarn\.lock|\bapi\b|route|server|handler|middleware|network|http|fetch/i;
const PERF_PATH = /loop|query|\bdb\b|cache|index|render|worker|stream|batch|queue|sort|search|scan|parse|pool|bundle|image|migration|hot/i;

const changedLines = (file: ChangedFile): number => (file.whole ? WHOLE_FILE_LINES : file.ranges.reduce((sum, [from, to]) => sum + (to - from + 1), 0));

const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/');

/** Picks lenses by what the change touches. Every lens lands in exactly one of `selected` and `skipped`, with a reason. `all` forces every lens. */
export function planLenses(files: ChangedFile[], all = false): Plan {
  const source = files.filter((f) => f.kind === 'source');
  const test = files.filter((f) => f.kind === 'test');
  const lines = source.reduce((sum, f) => sum + changedLines(f), 0);
  const dirs = new Set(source.map((f) => dirOf(f.path)));
  const stats = { files: files.length, source: source.length, test: test.length, other: files.length - source.length - test.length, changedLines: files.reduce((sum, f) => sum + changedLines(f), 0) };
  const decide = (lens: Lens): string | { skip: string } => {
    if (files.length === 0) return { skip: 'no changed files' };
    const some = (re: RegExp): boolean => files.some((f) => re.test(f.path));
    switch (lens) {
      case 'spec':
        return 'every change has an intended behavior to check against the task';
      case 'standards':
        return source.length + test.length > 0 ? 'code or tests changed: repo rules and conventions apply' : { skip: 'only prose or configuration changed: no code standards to enforce' };
      case 'adversarial':
        return source.length > 0 ? 'source changed: hostile input, partial failure and re-entry are possible' : { skip: 'no source change to attack' };
      case 'security':
        return some(SECURITY_PATH) ? 'paths touch auth, input handling, execution, network, hooks or dependency and CI manifests' : { skip: 'no security-sensitive path in the change' };
      case 'performance':
        return source.length > 0 && (lines >= PERF_LINES || source.some((f) => PERF_PATH.test(f.path)))
          ? 'large source change or hot-path file names'
          : { skip: `source change under ${PERF_LINES} lines with no hot-path file names` };
      case 'test-quality':
        return source.length + test.length > 0 ? 'code or tests changed: tests must be able to fail' : { skip: 'no code or test change' };
      case 'architecture':
        return source.length >= ARCH_FILES || dirs.size >= 2 || lines >= ARCH_LINES ? 'change spans several files or directories, or is large' : { skip: 'small change inside one directory' };
    }
  };
  const selected: Choice[] = [];
  const skipped: Choice[] = [];
  for (const lens of LENSES) {
    const decision = decide(lens);
    if (all) selected.push({ lens, reason: 'forced by --all' });
    else if (typeof decision === 'string') selected.push({ lens, reason: decision });
    else skipped.push({ lens, reason: decision.skip });
  }
  return { selected, skipped, stats };
}

/** Files from a verify-scope JSON document; null when the text is not one. Never throws. */
export function parseScope(body: string): ChangedFile[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const files = (raw as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return null;
  const kinds: string[] = ['source', 'test', 'other'];
  const out: ChangedFile[] = [];
  for (const entry of files as Array<Record<string, unknown> | null>) {
    if (typeof entry?.path !== 'string' || typeof entry.kind !== 'string' || !kinds.includes(entry.kind)) return null;
    const ranges = (Array.isArray(entry.ranges) ? entry.ranges : []).filter((r): r is [number, number] => Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number');
    out.push({ path: entry.path, kind: entry.kind as FileKind, ranges, whole: entry.whole === true });
  }
  return out;
}

const USAGE = 'usage: review-lenses.ts <scope.json> [--all]';

export type Read = (file: string) => string | null;

export const realRead: Read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, read: Read = realRead): number {
  const all = argv.includes('--all');
  const rest = argv.filter((a) => a !== '--all');
  const [file] = rest;
  if (file === undefined || rest.length !== 1) {
    err(USAGE);
    return 2;
  }
  const files = parseScope(read(file) ?? '');
  if (files === null) {
    err(`${file} is missing or not a verify-scope.ts result`);
    return 2;
  }
  out(JSON.stringify(planLenses(files, all)));
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
