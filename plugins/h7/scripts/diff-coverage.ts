import { readFileSync } from 'node:fs';
import type { Scope, ScopeFile } from './verify-scope.ts';

export interface LcovRecord {
  file: string;
  /** line -> hit count */
  lines: Map<number, number>;
  /** one entry per branch: its line and whether it was taken */
  branches: Array<{ line: number; taken: boolean }>;
}

export function parseLcov(text: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let current: LcovRecord | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      current = { file: line.slice(3).replace(/\\/g, '/'), lines: new Map(), branches: [] };
      records.push(current);
    } else if (current !== null && line.startsWith('DA:')) {
      const [at, hits] = line.slice(3).split(',');
      current.lines.set(Number(at), Number(hits));
    } else if (current !== null && line.startsWith('BRDA:')) {
      const [at, , , taken] = line.slice(5).split(',');
      current.branches.push({ line: Number(at), taken: taken !== '-' && Number(taken) > 0 });
    } else if (line === 'end_of_record') {
      current = null;
    }
  }
  return records;
}

export interface Ratio {
  covered: number;
  total: number;
  pct: number;
}

const ratio = (covered: number, total: number): Ratio => ({ covered, total, pct: total === 0 ? 100 : (covered * 100) / total });
const EPSILON = 1e-9;

/** Whole-run coverage of an lcov report. */
export function globalCoverage(records: LcovRecord[]): { lines: Ratio; branches: Ratio } {
  let lines = 0;
  let linesHit = 0;
  let branches = 0;
  let branchesHit = 0;
  for (const record of records) {
    for (const hits of record.lines.values()) {
      lines++;
      linesHit += Number(hits > 0);
    }
    for (const branch of record.branches) {
      branches++;
      branchesHit += Number(branch.taken);
    }
  }
  return { lines: ratio(linesHit, lines), branches: ratio(branchesHit, branches) };
}

export interface FileCoverage {
  path: string;
  /** Source file with changed lines that the report does not know at all. */
  missing: boolean;
  uncoveredLines: number[];
  uncoveredBranches: number[];
}

export interface Options {
  lines: number;
  branches: number;
}

export interface Verdict {
  pass: boolean;
  lines: Ratio;
  branches: Ratio;
  files: FileCoverage[];
  global?: { lines: { current: number; baseline: number }; branches: { current: number; baseline: number }; dropped: boolean };
  reasons: string[];
}

const inRanges = (line: number, file: ScopeFile): boolean => file.whole || file.ranges.some(([from, to]) => line >= from && line <= to);

function findRecord(records: LcovRecord[], path: string): LcovRecord | undefined {
  return records.find((record) => record.file === path || record.file.endsWith(`/${path}`));
}

/** Coverage of only the added and modified lines of changed source files. Test and other files are not measured. */
export function diffCoverage(scope: Pick<Scope, 'files'>, records: LcovRecord[], options: Options, baseline?: LcovRecord[]): Verdict {
  const files: FileCoverage[] = [];
  let lines = 0;
  let linesHit = 0;
  let branches = 0;
  let branchesHit = 0;
  const reasons: string[] = [];
  for (const file of scope.files.filter((f) => f.kind === 'source')) {
    if (!file.whole && file.ranges.length === 0) continue;
    const record = findRecord(records, file.path);
    if (record === undefined) {
      files.push({ path: file.path, missing: true, uncoveredLines: [], uncoveredBranches: [] });
      reasons.push(`${file.path}: not in the coverage report`);
      continue;
    }
    const uncoveredLines: number[] = [];
    for (const [at, hits] of record.lines) {
      if (!inRanges(at, file)) continue;
      lines++;
      if (hits > 0) linesHit++;
      else uncoveredLines.push(at);
    }
    const uncoveredBranches: number[] = [];
    for (const branch of record.branches) {
      if (!inRanges(branch.line, file)) continue;
      branches++;
      if (branch.taken) branchesHit++;
      else uncoveredBranches.push(branch.line);
    }
    files.push({ path: file.path, missing: false, uncoveredLines, uncoveredBranches });
  }
  const linesRatio = ratio(linesHit, lines);
  const branchesRatio = ratio(branchesHit, branches);
  if (linesRatio.pct < options.lines - EPSILON) reasons.push(`diff line coverage ${linesRatio.pct.toFixed(1)}% is below ${options.lines}%`);
  if (branchesRatio.pct < options.branches - EPSILON) reasons.push(`diff branch coverage ${branchesRatio.pct.toFixed(1)}% is below ${options.branches}%`);
  const verdict: Verdict = { pass: false, lines: linesRatio, branches: branchesRatio, files, reasons };
  if (baseline !== undefined) {
    const current = globalCoverage(records);
    const before = globalCoverage(baseline);
    const dropped = current.lines.pct < before.lines.pct - EPSILON || current.branches.pct < before.branches.pct - EPSILON;
    verdict.global = { lines: { current: current.lines.pct, baseline: before.lines.pct }, branches: { current: current.branches.pct, baseline: before.branches.pct }, dropped };
    if (dropped) reasons.push('global coverage dropped against the baseline');
  }
  verdict.pass = reasons.length === 0;
  return verdict;
}

const USAGE = 'usage: diff-coverage.ts --lcov <file> --scope <file> [--baseline <lcov>] [--lines <pct>] [--branches <pct>]';
const FLAGS = ['--lcov', '--scope', '--baseline', '--lines', '--branches'];

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): number {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] as string;
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || value === undefined) {
      err(USAGE);
      return 2;
    }
    values.set(flag, value);
  }
  const percent = (flag: string): number => (values.has(flag) ? Number(values.get(flag)) : 100);
  const options = { lines: percent('--lines'), branches: percent('--branches') };
  const lcov = values.get('--lcov');
  const scopePath = values.get('--scope');
  if (lcov === undefined || scopePath === undefined || ![options.lines, options.branches].every((n) => n >= 0 && n <= 100)) {
    err(USAGE);
    return 2;
  }
  try {
    const scope = JSON.parse(read(scopePath)) as Scope;
    if (!Array.isArray(scope.files)) throw new Error(`${scopePath} is not a verify-scope.ts result`);
    const baselinePath = values.get('--baseline');
    const verdict = diffCoverage(scope, parseLcov(read(lcov)), options, baselinePath === undefined ? undefined : parseLcov(read(baselinePath)));
    out(JSON.stringify(verdict));
    return verdict.pass ? 0 : 1;
  } catch (error) {
    err((error as Error).message);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
